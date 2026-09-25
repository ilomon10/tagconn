import { existsSync } from 'node:fs';
import type { Agent, TokenUsage } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import type { HookContext } from '../../core/event-bus/index.js';
import { mainAgentId, publicAgent } from '../agents/index.js';
import { createReadState, readTranscriptUsage, type TranscriptReadState } from './transcripts.parser.js';
import { resolveHookTranscriptPath, subagentTranscriptPath } from './transcripts.paths.js';

/** Claude Code's own session/agent ids; also the shape we build filesystem paths out of, so anything
 *  that doesn't match this is rejected before it ever reaches a `join()`. */
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface TrackedFile {
  /** The agentsRepository row id this file's usage belongs to ('main:<sessionId>' or Claude's agent_id). */
  agentId: string;
  /** The session this file was tracked under; usage is only ever applied if the agent still agrees. */
  sessionId: string;
  path: string;
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
 * cases (e.g. events missed across a Docker bind mount) to reason about. SubagentStop forces one final
 * synchronous read before we stop tracking a file; SessionEnd defers its final reads (see
 * `finalizeSession`) so a burst of session-end hooks never blocks the request that triggered them.
 *
 * Tracked files are keyed by `${sessionId}:${agentId}` (not `agentId` alone): Claude's `agent_id` has no
 * uniqueness guarantee across sessions, and `applyAgentUsage` additionally refuses to apply usage unless
 * the agent row's own `sessionId` still agrees, so a hook claiming someone else's `agent_id` under a
 * different session can never overwrite that agent's real usage.
 */
export class TranscriptsService {
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

  /** Bus `agent.removed`: stop tracking that agent's file(s), across any session. */
  untrackAgent(agentId: string): void {
    for (const key of [...this.files.keys()]) {
      if (this.files.get(key)?.agentId === agentId) this.untrack(key);
    }
  }

  /**
   * Bus `session.upserted` (status 'ended') and the SessionEnd hook both converge here. Whichever
   * fires first does the real work (final read + untrack for every file of this session); the other is
   * a safe no-op, since by then nothing is left tracked for the session. Called via `setImmediate` from
   * both call sites so it never runs synchronously on the request that triggered it.
   */
  finalizeSession(sessionId: string): void {
    for (const key of [...this.files.keys()]) {
      const f = this.files.get(key);
      if (!f || f.sessionId !== sessionId) continue;
      this.readNow(key);
      this.untrack(key);
    }
  }

  onHook(ctx: HookContext): void {
    if (!this.deps.settings.get().transcripts.enabled) return;
    const p = ctx.payload;
    if (!ID_RE.test(ctx.sessionId)) return; // not a shape we'll ever build a safe path out of
    const projectsDir = this.deps.settings.get().paths.projectsDir;
    const mainId = mainAgentId(ctx.sessionId);
    const mainKey = this.key(ctx.sessionId, mainId);

    const mainPath = resolveHookTranscriptPath(p.transcript_path, projectsDir);
    if (mainPath) this.ensure(mainId, ctx.sessionId, mainPath);

    let subKey: string | undefined;
    if (p.agent_id && ID_RE.test(p.agent_id)) {
      const subPath =
        resolveHookTranscriptPath(p.agent_transcript_path, projectsDir) ??
        (mainPath ? subagentTranscriptPath(mainPath, ctx.sessionId, p.agent_id, projectsDir) : undefined);
      if (subPath) this.ensure(p.agent_id, ctx.sessionId, subPath);
      subKey = this.key(ctx.sessionId, p.agent_id);
    }

    if (subKey) {
      if (p.hook_event_name === 'SubagentStop') {
        this.readNow(subKey);
        this.untrack(subKey);
      } else if (this.files.has(subKey)) {
        this.schedule(subKey);
      }
    }

    if (p.hook_event_name === 'SessionEnd') {
      // Off the request path: a burst of SessionEnd hooks (main + every still-tracked subagent) must
      // never block the HTTP response on synchronous transcript reads.
      setImmediate(() => this.finalizeSession(ctx.sessionId));
    } else if (this.files.has(mainKey)) {
      this.schedule(mainKey);
    }
  }

  private key(sessionId: string, agentId: string): string {
    return `${sessionId}:${agentId}`;
  }

  /** Only tracks a file when there's a live agent/session row for it and the file actually exists yet;
   *  never (re-)tracks a file for an agent that's already off the floor (`removed`). */
  private ensure(agentId: string, sessionId: string, path: string): void {
    if (!existsSync(path)) return;
    if (!this.deps.sessionsRepository.get(sessionId)) return;
    const agent = this.deps.agentsRepository.get(agentId);
    if (!agent || agent.removed) return;

    const key = this.key(sessionId, agentId);
    const existing = this.files.get(key);
    if (existing && existing.path === path) {
      this.touch(key); // same file already tracked: keep offset/dedupe state, just bump LRU order
      return;
    }
    clearTimeout(existing?.timer);
    this.files.set(key, { agentId, sessionId, path, state: createReadState() });
    this.evictLeastRecentlyUsed();
  }

  private untrack(key: string): void {
    clearTimeout(this.files.get(key)?.timer);
    this.files.delete(key);
  }

  /** Bumps `key` to most-recently-used (Map iteration order doubles as LRU order). */
  private touch(key: string): void {
    const f = this.files.get(key);
    if (!f) return;
    this.files.delete(key);
    this.files.set(key, f);
  }

  /** Caps the number of concurrently tracked files: an attacker who controls `agent_id` must not be
   *  able to grow this map without bound (each entry holds an open read cursor + per-message usage). */
  private evictLeastRecentlyUsed(): void {
    const cap = this.deps.settings.get().transcripts.maxTrackedFiles;
    while (this.files.size > cap) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      this.deps.logger.warn({ key: oldest, cap }, 'transcripts: maxTrackedFiles exceeded, evicting least-recently-used file');
      this.untrack(oldest);
    }
  }

  private schedule(key: string): void {
    const f = this.files.get(key);
    if (!f) return;
    clearTimeout(f.timer);
    const ms = this.deps.settings.get().transcripts.debounceMs;
    f.timer = setTimeout(() => {
      f.timer = undefined;
      this.readNow(key);
    }, ms);
    f.timer.unref();
  }

  private readNow(key: string): void {
    const f = this.files.get(key);
    if (!f) return;
    clearTimeout(f.timer);
    f.timer = undefined;
    const { maxLineBytes, maxFileBytes } = this.deps.settings.get().transcripts;
    const projectsDir = this.deps.settings.get().paths.projectsDir;
    let usage: TokenUsage | undefined;
    try {
      usage = readTranscriptUsage(f.path, f.state, projectsDir, { maxLineBytes, maxFileBytes }, () =>
        this.deps.logger.warn({ path: f.path, maxFileBytes }, 'transcripts: file exceeds maxFileBytes, no longer reading new bytes'),
      );
    } catch (err) {
      this.deps.logger.warn({ err, path: f.path }, 'failed to read transcript');
      return;
    }
    if (this.applyAgentUsage(f.agentId, f.sessionId, usage)) this.recomputeSessionUsage(f.sessionId);
  }

  /**
   * Returns true when the agent's usage actually changed (so the caller knows to recompute the
   * session). Refuses for an agent that's no longer on the floor (`removed`) and for one whose *true*
   * owning session (its own `sessionId`) doesn't match the session this file was tracked under — the
   * cross-session hijack guard described on the class doc.
   */
  private applyAgentUsage(agentId: string, sessionId: string, usage: TokenUsage | undefined): boolean {
    const agent = this.deps.agentsRepository.get(agentId);
    if (!agent || agent.removed || agent.sessionId !== sessionId || equalUsage(agent.usage, usage)) return false;
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
