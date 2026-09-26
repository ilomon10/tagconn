import { isTerminalRunStatus, type Session } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import type { BusEvents, HookContext } from '../../core/event-bus/index.js';

export const PROMPT_MAX = 200;

export const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Sweep cadence, same as the agents idle/removal sweeper. */
const SWEEP_MS = 5_000;

export class SessionsService {
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly deps: Deps<
      'sessionsRepository' | 'agentsRepository' | 'agentsService' | 'settings' | 'bus' | 'logger' | 'runLinker' | 'runDispatcher'
    >,
  ) {}

  start(): void {
    this.sweep();
    this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweeper.unref();
  }

  stop(): void {
    clearInterval(this.sweeper);
  }

  /** Lazily creates the session and applies lifecycle transitions. */
  onHook(ctx: HookContext): void {
    const { payload: p, ts } = ctx;
    const repo = this.deps.sessionsRepository;
    const prev = repo.get(ctx.sessionId);
    const next: Session = prev ? { ...prev } : { id: ctx.sessionId, projectId: ctx.projectId, status: 'active', startedAt: ts };
    next.projectId = ctx.projectId;
    if (p.permission_mode) next.permissionMode = p.permission_mode;
    if (!prev) next.origin = 'cli';
    this.linkRun(ctx, next);

    const inMain = !p.agent_id;
    switch (p.hook_event_name) {
      case 'SessionStart':
        next.status = 'active';
        next.endedAt = undefined;
        break;
      case 'UserPromptSubmit':
        if (inMain) {
          next.status = 'active';
          if (p.prompt) next.lastPrompt = truncate(p.prompt, PROMPT_MAX);
        }
        break;
      case 'Stop':
        if (inMain) next.status = 'idle';
        break;
      case 'SessionEnd':
        next.status = 'ended';
        next.endedAt = ts;
        break;
    }

    const changed = !prev || JSON.stringify(prev) !== JSON.stringify(next);
    repo.upsert(next, ts);
    if (changed) this.deps.bus.emit('session.upserted', next);
  }

  /**
   * M8 8k, S5 (§2.6 "Hint"): the `x-tagconn-run-id` header only ever links an existing,
   * non-terminal, unlinked QUEST run — and never across projects. `runDispatcher.get` reads the run
   * (never trusted on its own); a project mismatch is logged and ignored, leaving `origin: 'cli'`.
   * `runLinker.hint` lets the runs module record the same link on its side (`run.linked`, so the
   * quest board can show the live character) and is a no-op once `init` has already linked the run.
   */
  private linkRun(ctx: HookContext, next: Session): void {
    if (next.runId || !ctx.runIdHint) return;
    const run = this.deps.runDispatcher.get(ctx.runIdHint);
    if (!run || isTerminalRunStatus(run.status)) return;
    if (run.kind !== 'quest' || run.projectId !== next.projectId) {
      this.deps.logger.warn(
        { runId: ctx.runIdHint, sessionId: ctx.sessionId, runKind: run.kind, runProjectId: run.projectId, sessionProjectId: next.projectId },
        'ignoring x-tagconn-run-id hint: run does not belong to this session project',
      );
      return;
    }
    next.runId = ctx.runIdHint;
    next.origin = 'quest';
    this.deps.runLinker.hint(ctx.runIdHint, ctx.sessionId);
  }

  /**
   * M8 8k, S5 (§2.6 "Authoritative"): `runs` emits this once a run's own `init` event reports its
   * Claude `session_id` (or, before that lands, from the header hint it already echoed back via
   * `runLinker.hint` above — either way this is the run's side of the same link). Unlike `linkRun`
   * above (session hook -> run), this is the run -> session direction, and `hook.received`/`run.linked`
   * can race in either order:
   *  - SessionStart-before-init: the row already exists (origin 'cli', no runId yet); this upgrades it.
   *  - init-before-SessionStart: no row exists yet; this creates it lazily (same shape `onHook`'s own
   *    lazy-create uses). The SessionStart hook that arrives afterwards then only fills in the rest,
   *    since `linkRun` never resets an existing runId/origin (`if (next.runId || ...) return`).
   * Never crosses projects: an existing session's project always wins, and a mismatch is ignored+warned
   * exactly like `linkRun`'s own guard. Idempotent: relinking the same run onto an already-linked
   * session is a no-op (no repository write, no re-emit).
   */
  onRunLinked(e: BusEvents['run.linked']): void {
    const run = this.deps.runDispatcher.get(e.runId);
    if (!run || run.kind !== 'quest') return; // never link a Session to a non-quest (receptionist) run
    if (!e.projectId) {
      this.deps.logger.warn({ runId: e.runId, sessionId: e.sessionId }, 'ignoring run.linked: run has no projectId');
      return;
    }
    const repo = this.deps.sessionsRepository;
    const prev = repo.get(e.sessionId);
    if (prev && prev.projectId !== e.projectId) {
      this.deps.logger.warn(
        { runId: e.runId, sessionId: e.sessionId, runProjectId: e.projectId, sessionProjectId: prev.projectId },
        'ignoring run.linked: run does not belong to this session project',
      );
      return;
    }
    if (prev?.runId === e.runId && prev.origin === 'quest') return; // already linked: idempotent re-link
    const now = Date.now();
    const next: Session = prev
      ? { ...prev, runId: e.runId, origin: 'quest' }
      : { id: e.sessionId, projectId: e.projectId, status: 'active', startedAt: now, runId: e.runId, origin: 'quest' };
    repo.upsert(next, now);
    this.deps.bus.emit('session.upserted', next);
  }

  /**
   * Marks sessions idle/ended purely from inactivity: 'idle' after sessions.idleAfterSec with no hook
   * event, 'ended' after sessions.endAfterSec with no live agents left either. Uses setStatus (not
   * upsert) so marking a session idle doesn't reset the staleness clock the ended-transition measures
   * from.
   */
  sweep(now = Date.now()): void {
    const { idleAfterSec, endAfterSec } = this.deps.settings.get().sessions;
    const idleCutoff = now - idleAfterSec * 1000;
    const endedCutoff = now - endAfterSec * 1000;
    const repo = this.deps.sessionsRepository;
    const endedIds = new Set<string>();

    for (const s of repo.staleSince(endedCutoff)) {
      // "No live agents": every agent of this session is either off the floor already (removed) or
      // itself stale past the ended cutoff. A plain `!removed` check would never fire here in
      // practice — the always-present main agent only leaves 'active' via an explicit SessionEnd,
      // which is exactly the event this sweep exists to cover for sessions that never sent one
      // (crashed/killed CLI). Recency, not the removed flag alone, is what actually indicates "live".
      if (this.deps.agentsRepository.bySession(s.id).some((a) => !a.removed && a.updatedAt >= endedCutoff)) continue;
      endedIds.add(s.id);
      repo.setStatus(s.id, 'ended', now);
      this.deps.bus.emit('session.upserted', { ...s, status: 'ended', endedAt: now });
      // Crashed/killed CLI: no SessionEnd hook ever came, so its agents (PM included) never went
      // through the hook-driven SessionEnd path. Finish them the same way, so none linger forever.
      this.deps.agentsService.finishSessionAgents(s.id, now);
    }

    for (const s of repo.staleSince(idleCutoff)) {
      if (endedIds.has(s.id) || s.status !== 'active') continue;
      repo.setStatus(s.id, 'idle');
      this.deps.bus.emit('session.upserted', { ...s, status: 'idle' });
    }
  }
}
