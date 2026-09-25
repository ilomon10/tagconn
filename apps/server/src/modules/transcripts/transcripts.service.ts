import type { Agent, TokenUsage } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import type { HookContext } from '../../core/event-bus/index.js';
import { mainAgentId, publicAgent } from '../agents/index.js';
import { createReadState, readTranscriptUsage, type TranscriptReadState } from './transcripts.parser.js';
import { resolveHookTranscriptPath, subagentTranscriptPath } from './transcripts.paths.js';

interface TrackedFile {
  path: string;
  sessionId: string;
  state: TranscriptReadState;
  timer?: NodeJS.Timeout;
}

type TranscriptsDeps = Deps<'agentsRepository' | 'sessionsRepository' | 'settings' | 'bus' | 'logger'>;

const equalUsage = (a: TokenUsage | undefined, b: TokenUsage | undefined) => JSON.stringify(a) === JSON.stringify(b);

/** Sums usage over the main agent + its subagents; contextTokens/model come from the main agent only. */
function sumUsage(agents: Pick<Agent, 'isMain' | 'usage'>[]): TokenUsage | undefined {
  const present = agents.map((a) => a.usage).filter((u): u is TokenUsage => u !== undefined);
  if (present.length === 0) return undefined;
  const totals = present.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cacheReadTokens: acc.cacheReadTokens + u.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens + u.cacheCreationTokens,
      messages: acc.messages + u.messages,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, messages: 0 },
  );
  const main = agents.find((a) => a.isMain)?.usage;
  return { ...totals, contextTokens: main?.contextTokens ?? 0, model: main?.model };
}

/**
 * Reads token usage out of Claude Code transcripts (JSONL: one per main session, one per subagent) and
 * mirrors it onto `agent.usage` / `session.usage`, re-emitting the existing `agent:upsert` /
 * `session:upsert` bus events so socket clients pick it up like any other change.
 *
 * Tracking is entirely hook-driven, not chokidar-watched: every hook event already tells us which
 * file(s) are relevant (the main session's `transcript_path`, plus a path we derive for the event's
 * subagent, if any) and schedules a debounced re-read of them. Hooks fire on effectively every turn
 * (PreToolUse/PostToolUse bracket each tool call), so this catches new usage within `debounceMs` of it
 * landing without a second file-watching subsystem, extra inotify/FD usage, or watcher-vs-poll edge
 * cases (e.g. events missed across a Docker bind mount) to reason about. SubagentStop/SessionEnd force
 * one final synchronous read before we stop tracking a file, so nothing is lost to a pending debounce.
 */
export class TranscriptsService {
  /** Keyed by agentId: 'main:<sessionId>' for the main session, otherwise Claude's agent_id. */
  private readonly files = new Map<string, TrackedFile>();

  constructor(private readonly deps: TranscriptsDeps) {}

  stop(): void {
    for (const f of this.files.values()) clearTimeout(f.timer);
    this.files.clear();
  }

  /** transcripts.enabled flipped off: drop all tracking immediately (hot-apply). */
  disable(): void {
    this.stop();
  }

  onHook(ctx: HookContext): void {
    if (!this.deps.settings.get().transcripts.enabled) return;
    const p = ctx.payload;
    const projectsDir = this.deps.settings.get().paths.projectsDir;
    const mainId = mainAgentId(ctx.sessionId);

    const mainPath = resolveHookTranscriptPath(p.transcript_path, projectsDir);
    if (mainPath) this.ensure(mainId, ctx.sessionId, mainPath);

    let subId: string | undefined;
    if (p.agent_id) {
      subId = p.agent_id;
      const subPath =
        resolveHookTranscriptPath(p.agent_transcript_path, projectsDir) ??
        (mainPath ? subagentTranscriptPath(mainPath, ctx.sessionId, p.agent_id, projectsDir) : undefined);
      if (subPath) this.ensure(subId, ctx.sessionId, subPath);
    }

    if (subId) {
      if (p.hook_event_name === 'SubagentStop') {
        this.readNow(subId);
        this.untrack(subId);
      } else if (this.files.has(subId)) {
        this.schedule(subId);
      }
    }

    if (p.hook_event_name === 'SessionEnd') {
      // Final read for every file still tracked for this session (main + any subagent that never
      // got its own SubagentStop, e.g. a crashed/killed CLI), then stop tracking all of them.
      for (const id of [...this.files.keys()]) {
        if (this.files.get(id)?.sessionId !== ctx.sessionId) continue;
        this.readNow(id);
        this.untrack(id);
      }
    } else if (this.files.has(mainId)) {
      this.schedule(mainId);
    }
  }

  private ensure(agentId: string, sessionId: string, path: string): void {
    const existing = this.files.get(agentId);
    if (existing && existing.path === path) return; // same file already tracked: keep offset/dedupe state
    clearTimeout(existing?.timer);
    this.files.set(agentId, { path, sessionId, state: createReadState() });
  }

  private untrack(agentId: string): void {
    clearTimeout(this.files.get(agentId)?.timer);
    this.files.delete(agentId);
  }

  private schedule(agentId: string): void {
    const f = this.files.get(agentId);
    if (!f) return;
    clearTimeout(f.timer);
    const ms = this.deps.settings.get().transcripts.debounceMs;
    f.timer = setTimeout(() => {
      f.timer = undefined;
      this.readNow(agentId);
    }, ms);
    f.timer.unref();
  }

  private readNow(agentId: string): void {
    const f = this.files.get(agentId);
    if (!f) return;
    clearTimeout(f.timer);
    f.timer = undefined;
    let usage: TokenUsage | undefined;
    try {
      usage = readTranscriptUsage(f.path, f.state);
    } catch (err) {
      this.deps.logger.warn({ err, path: f.path }, 'failed to read transcript');
      return;
    }
    if (this.applyAgentUsage(agentId, usage)) this.recomputeSessionUsage(f.sessionId);
  }

  /** Returns true when the agent's usage actually changed (so the caller knows to recompute the session). */
  private applyAgentUsage(agentId: string, usage: TokenUsage | undefined): boolean {
    const agent = this.deps.agentsRepository.get(agentId);
    if (!agent || equalUsage(agent.usage, usage)) return false;
    this.deps.agentsRepository.updateUsage(agentId, usage);
    this.deps.bus.emit('agent.upserted', publicAgent({ ...agent, usage }));
    return true;
  }

  private recomputeSessionUsage(sessionId: string): void {
    const session = this.deps.sessionsRepository.get(sessionId);
    if (!session) return;
    const usage = sumUsage(this.deps.agentsRepository.bySession(sessionId));
    if (equalUsage(session.usage, usage)) return;
    this.deps.sessionsRepository.updateUsage(sessionId, usage);
    this.deps.bus.emit('session.upserted', { ...session, usage });
  }
}
