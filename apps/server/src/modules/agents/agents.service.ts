import { MAIN_ROLE, type Zone } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import type { HookContext } from '../../core/event-bus/index.js';
import { type AgentRecord, publicAgent } from './agents.repository.js';

export const mainAgentId = (sessionId: string) => `main:${sessionId}`;
export const DEFAULT_SUBAGENT_TYPE = 'general-purpose';
const FALLBACK_ROLE = 'developer';
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const SWEEP_MS = 5_000;
const LAST_MESSAGE_MAX = 4_000;
const EARLY_LINK_MAX_AGE_MS = 10 * 60 * 1000;

interface PendingCall {
  toolUseId: string;
  description?: string;
  subagentType: string;
}

/** An authoritative (toolUseId, description) pair for an agentId whose SubagentStart hasn't landed yet. */
interface EarlyLink {
  toolUseId: string;
  description?: string;
  ts: number;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

type AgentsDeps = Deps<'agentsRepository' | 'activityService' | 'rolesService' | 'settings' | 'bus' | 'logger'>;

/**
 * Character state machine. Events carrying `agent_id` belong to that subagent, everything else to
 * the session's main agent (`main:<sessionId>`, role pm).
 */
export class AgentsService {
  /** Agent tool calls not yet matched to a SubagentStart, FIFO per session. */
  private readonly pending = new Map<string, PendingCall[]>();
  /**
   * PostToolUse(Agent) landed before its own SubagentStart (agentId → its authoritative call),
   * per session. SubagentStart consults this first, before the FIFO `matchPending` guess.
   */
  private readonly earlyLinks = new Map<string, Map<string, EarlyLink>>();
  private readonly removalTimers = new Map<string, NodeJS.Timeout>();
  private sweeper?: NodeJS.Timeout;

  constructor(private readonly deps: AgentsDeps) {}

  start(): void {
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  stop(): void {
    clearInterval(this.sweeper);
    for (const t of this.removalTimers.values()) clearTimeout(t);
    this.removalTimers.clear();
  }

  resolveRole(agentType: string): string {
    const mapped = this.deps.settings.get().agents.typeToRole[agentType];
    if (mapped) return mapped;
    return this.deps.rolesService.get(agentType) ? agentType : FALLBACK_ROLE;
  }

  private roleZone(a: AgentRecord): Zone {
    return this.deps.rolesService.get(a.role)?.zone ?? (a.isMain ? 'pm-office' : 'desks');
  }

  onHook(ctx: HookContext): void {
    const { payload: p, ts } = ctx;
    const main = this.ensureAgent(ctx, mainAgentId(ctx.sessionId), true);
    const agent = p.agent_id ? this.ensureAgent(ctx, p.agent_id, false) : main;
    const a: AgentRecord = { ...agent, updatedAt: ts };
    const toolName = p.tool_name ?? '';
    const input = obj(p.tool_input);

    if (a.removed && p.hook_event_name !== 'SessionEnd' && p.hook_event_name !== 'SubagentStop') {
      a.removed = false; // back on the floor (resumed session / agent)
      this.cancelRemoval(a.id);
    }

    switch (p.hook_event_name) {
      case 'SessionStart':
        Object.assign(a, { status: 'active', activity: 'idle', zone: this.roleZone(a), bubble: 'Session started', endedAt: undefined });
        break;
      case 'UserPromptSubmit':
        Object.assign(a, { status: 'active', activity: 'thinking', zone: this.roleZone(a), bubble: 'Thinking', currentTool: undefined });
        break;
      case 'SubagentStart':
        this.linkStart(ctx, a);
        Object.assign(a, { status: 'active', activity: 'thinking', zone: this.roleZone(a), bubble: a.description ?? 'Starting', endedAt: undefined });
        break;
      case 'PreToolUse': {
        const m = this.deps.activityService.map(toolName, input, this.roleZone(a));
        Object.assign(a, { status: 'active', activity: m.activity, zone: m.zone, bubble: m.bubble, currentTool: toolName || undefined });
        a.toolCount += 1;
        if (AGENT_TOOLS.has(toolName) && p.tool_use_id) {
          this.queuePending(ctx.sessionId, {
            toolUseId: p.tool_use_id,
            description: str(input.description),
            subagentType: str(input.subagent_type) ?? DEFAULT_SUBAGENT_TYPE,
          });
        }
        break;
      }
      case 'PostToolUse':
        a.status = 'active';
        if (a.activity === 'waiting' || a.activity === 'idle' || a.activity === 'done') a.activity = 'thinking';
        a.currentTool = undefined;
        if (AGENT_TOOLS.has(toolName)) this.linkAgentCall(ctx, str(obj(p.tool_response).agentId), str(input.description));
        break;
      case 'PostToolUseFailure':
        Object.assign(a, { status: 'active', bubble: `Error: ${toolName || 'tool'}`, currentTool: undefined });
        if (AGENT_TOOLS.has(toolName) && p.tool_use_id) this.dropPending(ctx.sessionId, p.tool_use_id);
        break;
      case 'Notification':
        Object.assign(a, { status: 'waiting', activity: 'waiting', bubble: clip(p.message ?? 'Needs your input', 80) });
        break;
      case 'PreCompact':
        Object.assign(a, { activity: 'thinking', bubble: 'Compacting context' });
        break;
      case 'Stop': {
        const running = Array.isArray(p.background_tasks)
          ? p.background_tasks.filter((t) => obj(t).status === 'running').length
          : 0;
        Object.assign(
          a,
          running > 0
            ? { status: 'waiting', activity: 'delegating', bubble: `Waiting on ${running} agent${running > 1 ? 's' : ''}` }
            : { status: 'waiting', activity: 'waiting', bubble: 'Waiting for you' },
          { zone: this.roleZone(a), currentTool: undefined },
        );
        break;
      }
      case 'SubagentStop':
        this.finish(a, ts, 'Done');
        if (p.last_assistant_message) a.lastMessage = clip(p.last_assistant_message, LAST_MESSAGE_MAX);
        break;
      case 'SessionEnd':
        this.pending.delete(ctx.sessionId);
        this.earlyLinks.delete(ctx.sessionId);
        for (const other of this.deps.agentsRepository.bySession(ctx.sessionId)) {
          if (other.id === a.id || other.status === 'done') continue;
          const done = { ...other, updatedAt: ts };
          this.finish(done, ts, 'Bye');
          this.save(done);
        }
        this.finish(a, ts, 'Bye');
        break;
    }

    ctx.agentId = a.id;
    ctx.role = a.role;
    ctx.activity = a.activity;
    ctx.bubble = a.bubble;
    this.save(a);
  }

  private ensureAgent(ctx: HookContext, id: string, isMain: boolean): AgentRecord {
    const existing = this.deps.agentsRepository.get(id);
    if (existing) return existing;
    const agentType = isMain ? 'main' : (ctx.payload.agent_type ?? DEFAULT_SUBAGENT_TYPE);
    const agent: AgentRecord = {
      id,
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      isMain,
      agentType,
      role: isMain ? MAIN_ROLE : this.resolveRole(agentType),
      status: 'active',
      activity: 'idle',
      zone: 'entrance',
      toolCount: 0,
      startedAt: ctx.ts,
      updatedAt: ctx.ts,
      removed: false,
    };
    if (isMain) agent.zone = this.roleZone(agent);
    // A main agent first seen via a subagent event is not the one onHook saves, so persist it here.
    if (isMain && ctx.payload.agent_id) this.save(agent);
    return agent;
  }

  private finish(a: AgentRecord, ts: number, bubble: string): void {
    Object.assign(a, { status: 'done', activity: 'done', zone: 'entrance', bubble, currentTool: undefined, endedAt: ts });
    this.scheduleRemoval(a);
  }

  private save(a: AgentRecord): void {
    this.deps.agentsRepository.upsert(a);
    this.deps.bus.emit('agent.upserted', publicAgent(a));
  }

  private queuePending(sessionId: string, call: PendingCall): void {
    const list = this.pending.get(sessionId) ?? [];
    list.push(call);
    this.pending.set(sessionId, list);
  }

  private dropPending(sessionId: string, toolUseId: string): PendingCall | undefined {
    const list = this.pending.get(sessionId);
    const i = list?.findIndex((c) => c.toolUseId === toolUseId) ?? -1;
    return i >= 0 ? list?.splice(i, 1)[0] : undefined;
  }

  /**
   * SubagentStart: an early link (a PostToolUse(Agent) for this exact agentId that already arrived,
   * see `linkAgentCall`) is authoritative and takes priority; only fall back to the FIFO
   * `matchPending` guess when none is recorded.
   */
  private linkStart(ctx: HookContext, a: AgentRecord): void {
    const early = this.takeEarlyLink(ctx.sessionId, a.id);
    if (early) {
      ctx.linkedToolUseId = early.toolUseId;
      if (early.description && !a.description) a.description = early.description;
      return;
    }
    this.matchPending(ctx, a);
  }

  /** SubagentStart fallback: take the oldest pending Agent call of the same subagent type. */
  private matchPending(ctx: HookContext, a: AgentRecord): void {
    const list = this.pending.get(ctx.sessionId);
    const i = list?.findIndex((c) => c.subagentType === a.agentType) ?? -1;
    const call = i >= 0 ? list?.splice(i, 1)[0] : undefined;
    if (!call) return;
    ctx.linkedToolUseId = call.toolUseId;
    if (call.description && !a.description) a.description = call.description;
  }

  /**
   * PostToolUse Agent: tool_response.agentId + tool_input.description are paired exactly by
   * tool_use_id, so this is authoritative and overwrites the SubagentStart FIFO guess — even when
   * several same-type subagents started in an order that made the guess wrong. For a background
   * agent this runs right after SubagentStart; for a foreground (sync) agent it only runs after
   * SubagentStop, so `sub` may already be done/removed — still correct its row.
   *
   * If SubagentStart for this agentId hasn't landed yet (a real, observed live-run ordering: see
   * qa-parallel-subagent-early-posttooluse.test.ts), the agent record doesn't exist yet. Stash the
   * pairing as an "early link" for `linkStart` to consume authoritatively instead of dropping it —
   * `dropPending` above already removed it from the FIFO list so it can't be mis-assigned meanwhile.
   */
  private linkAgentCall(ctx: HookContext, agentId: string | undefined, description: string | undefined): void {
    const toolUseId = ctx.payload.tool_use_id;
    if (toolUseId) this.dropPending(ctx.sessionId, toolUseId);
    if (!agentId) return;
    const sub = this.deps.agentsRepository.get(agentId);
    if (sub) {
      if (description) this.save({ ...sub, description, updatedAt: ctx.ts });
      return;
    }
    if (toolUseId) this.setEarlyLink(ctx.sessionId, agentId, { toolUseId, description, ts: ctx.ts });
  }

  private setEarlyLink(sessionId: string, agentId: string, link: EarlyLink): void {
    const map = this.earlyLinks.get(sessionId) ?? new Map<string, EarlyLink>();
    map.set(agentId, link);
    this.earlyLinks.set(sessionId, map);
  }

  private takeEarlyLink(sessionId: string, agentId: string): EarlyLink | undefined {
    const map = this.earlyLinks.get(sessionId);
    const link = map?.get(agentId);
    if (!map || !link) return undefined;
    map.delete(agentId);
    if (map.size === 0) this.earlyLinks.delete(sessionId);
    return link;
  }

  private scheduleRemoval(a: AgentRecord): void {
    this.cancelRemoval(a.id);
    const timer = setTimeout(() => this.remove(a.id), this.deps.settings.get().agents.doneLingerSec * 1000);
    timer.unref();
    this.removalTimers.set(a.id, timer);
  }

  private cancelRemoval(id: string): void {
    const t = this.removalTimers.get(id);
    if (t) clearTimeout(t);
    this.removalTimers.delete(id);
  }

  /** Takes a finished agent off the live floor; the row is kept for history. */
  private remove(id: string): void {
    this.removalTimers.delete(id);
    const a = this.deps.agentsRepository.get(id);
    if (!a || a.removed || a.status !== 'done') return;
    this.markRemoved(a);
  }

  /**
   * Takes an agent off the live floor without touching its status/activity — used for a PM that's
   * gone quiet (still 'active'/'waiting', not 'done'). It reappears (removed: false) the moment the
   * top of `onHook` sees a later event for its id, same mechanism as a resumed done/removed agent.
   */
  private markRemoved(a: AgentRecord): void {
    this.deps.agentsRepository.upsert({ ...a, removed: true });
    this.deps.bus.emit('agent.removed', { id: a.id, projectId: a.projectId });
  }

  /**
   * A session ended by the sweep (crashed/killed CLI, no SessionEnd hook ever arrived): finish its
   * still-live agents the same way the SessionEnd hook path does, so its PM (and any subagents) don't
   * linger on the floor forever. A no-op for a session the SessionEnd hook already finished.
   */
  finishSessionAgents(sessionId: string, ts: number): void {
    for (const a of this.deps.agentsRepository.bySession(sessionId)) {
      // Already removed (e.g. a PM that left earlier via pmIdleLeaveSec): leave it be. Re-upserting it
      // here would broadcast 'agent:upsert' for an id the web already dropped via 'agent:remove',
      // resurrecting it on the floor with no matching remove event to follow.
      if (a.removed || a.status === 'done') continue;
      const done = { ...a, updatedAt: ts };
      this.finish(done, ts, 'Bye');
      this.save(done);
    }
  }

  sweep(now = Date.now()): void {
    try {
      const { idleAfterSec, doneLingerSec, staleAfterSec } = this.deps.settings.get().agents;
      const { pmIdleLeaveSec } = this.deps.settings.get().sessions;
      for (const a of this.deps.agentsRepository.staleActive(now - idleAfterSec * 1000)) {
        // Cosmetic only: don't bump updatedAt here, it must keep meaning "last real hook event" for
        // staleAfterSec/pmIdleLeaveSec below (and for sessions' own "no live agents" check) — this
        // transition itself isn't one, and its own `ne(activity, 'idle')` filter already keeps it from
        // re-matching on the next tick without needing a fresh timestamp.
        this.save({ ...a, activity: 'idle', zone: 'lounge', bubble: undefined, currentTool: undefined });
      }
      // Lost SubagentStop: no shared Agent field for "why it ended" without touching packages/shared's
      // domain.ts (out of scope here), so the reason is surfaced via the existing `bubble` text plus
      // this log line, not a new persisted field. Tasks are left untouched (still 'doing'): unlike a
      // real SessionEnd, a late event can still bring this agent back to life, and re-failing/reviving
      // its task on every flap would be worse than leaving it as-is until either a real event resumes
      // it or the session itself ends.
      for (const a of this.deps.agentsRepository.staleSubagents(now - staleAfterSec * 1000)) {
        this.deps.logger.info({ agentId: a.id, sessionId: a.sessionId }, 'agent stale (no events past staleAfterSec); marking done');
        const done = { ...a, updatedAt: now };
        this.finish(done, now, 'Stale (no activity)');
        this.save(done);
      }
      // A PM leaves only once its whole session has gone quiet (no other live agent either) — a PM
      // legitimately "waiting on N agents" must stay visible for as long as those agents are live.
      for (const a of this.deps.agentsRepository.idleMains(now - pmIdleLeaveSec * 1000)) {
        const hasLiveWork = this.deps.agentsRepository
          .bySession(a.sessionId)
          .some((o) => o.id !== a.id && !o.removed && o.status !== 'done');
        if (!hasLiveWork) this.markRemoved(a);
      }
      for (const a of this.deps.agentsRepository.doneBefore(now - doneLingerSec * 1000)) {
        if (!this.removalTimers.has(a.id)) this.remove(a.id);
      }
      this.sweepEarlyLinks(now);
    } catch (err) {
      this.deps.logger.error({ err }, 'agent sweeper failed');
    }
  }

  /** Bounds `earlyLinks`: a SubagentStart that never arrives (crashed/killed agent) must not leak. */
  private sweepEarlyLinks(now: number): void {
    const cutoff = now - EARLY_LINK_MAX_AGE_MS;
    for (const [sessionId, map] of this.earlyLinks) {
      for (const [agentId, link] of map) {
        if (link.ts < cutoff) map.delete(agentId);
      }
      if (map.size === 0) this.earlyLinks.delete(sessionId);
    }
  }
}
