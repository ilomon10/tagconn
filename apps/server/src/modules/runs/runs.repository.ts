import type { Run, RunEventEnvelope, RunKind } from '@tagconn/shared';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { runEvents, runs } from './runs.tables.js';

type RunRow = typeof runs.$inferSelect;

const toRun = (r: RunRow): Run => ({
  id: r.id,
  kind: r.kind,
  projectId: r.projectId ?? undefined,
  conversationId: r.conversationId ?? undefined,
  threadId: r.threadId,
  parentRunId: r.parentRunId ?? undefined,
  heroId: r.heroId ?? undefined,
  status: r.status,
  endReason: r.endReason ?? undefined,
  prompt: r.prompt,
  permissionMode: r.permissionMode,
  model: r.model,
  sessionId: r.sessionId ?? undefined,
  resumeSessionId: r.resumeSessionId ?? undefined,
  createdBy: r.createdBy,
  runnerId: r.runnerId ?? undefined,
  createdAt: r.createdAt,
  startedAt: r.startedAt ?? undefined,
  endedAt: r.endedAt ?? undefined,
  exitCode: r.exitCode ?? undefined,
  error: r.error ?? undefined,
  result: r.result ?? undefined,
  eventCount: r.eventCount,
  truncated: r.truncated,
});

export interface RunListFilter {
  projectId?: string;
  kind?: RunKind;
  limit: number;
}

/** DB access for `runs` and `run_events` (M8 8k, S2). Never imported outside this module. */
export class RunsRepository {
  constructor(private readonly deps: Deps<'db'>) {}

  get(id: string): Run | undefined {
    const row = this.deps.db.select().from(runs).where(eq(runs.id, id)).get();
    return row && toRun(row);
  }

  list(filter: RunListFilter): Run[] {
    const conds = [];
    if (filter.projectId) conds.push(eq(runs.projectId, filter.projectId));
    if (filter.kind) conds.push(eq(runs.kind, filter.kind));
    return this.deps.db
      .select()
      .from(runs)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(runs.createdAt))
      .limit(filter.limit)
      .all()
      .map(toRun);
  }

  /** Runs dispatched to (or running on) this runner, not yet ended. Queued runs are excluded: they
   * never carry a `runnerId` (it is only set once a run leaves the in-memory queue). */
  activeForRunner(runnerId: string): Run[] {
    return this.deps.db
      .select()
      .from(runs)
      .where(and(eq(runs.runnerId, runnerId), inArray(runs.status, ['dispatched', 'running'])))
      .all()
      .map(toRun);
  }

  insert(run: Run): void {
    this.deps.db
      .insert(runs)
      .values({
        ...run,
        projectId: run.projectId ?? null,
        conversationId: run.conversationId ?? null,
        parentRunId: run.parentRunId ?? null,
        heroId: run.heroId ?? null,
        endReason: run.endReason ?? null,
        sessionId: run.sessionId ?? null,
        resumeSessionId: run.resumeSessionId ?? null,
        runnerId: run.runnerId ?? null,
        startedAt: run.startedAt ?? null,
        endedAt: run.endedAt ?? null,
        exitCode: run.exitCode ?? null,
        error: run.error ?? null,
        result: run.result ?? null,
      })
      .run();
  }

  update(run: Run): void {
    const { id, ...rest } = run;
    this.deps.db
      .update(runs)
      .set({
        ...rest,
        projectId: run.projectId ?? null,
        conversationId: run.conversationId ?? null,
        parentRunId: run.parentRunId ?? null,
        heroId: run.heroId ?? null,
        endReason: run.endReason ?? null,
        sessionId: run.sessionId ?? null,
        resumeSessionId: run.resumeSessionId ?? null,
        runnerId: run.runnerId ?? null,
        startedAt: run.startedAt ?? null,
        endedAt: run.endedAt ?? null,
        exitCode: run.exitCode ?? null,
        error: run.error ?? null,
        result: run.result ?? null,
      })
      .where(eq(runs.id, id))
      .run();
  }

  /** Inserts one event; returns false (no write) if `(runId, seq)` already exists (runner replay dedupe). */
  appendEvent(env: RunEventEnvelope): boolean {
    const changes = this.deps.db
      .insert(runEvents)
      .values({ runId: env.runId, seq: env.seq, ts: env.ts, event: env.event })
      .onConflictDoNothing({ target: [runEvents.runId, runEvents.seq] })
      .run().changes;
    return changes > 0;
  }

  listEvents(runId: string, limit = 5_000): RunEventEnvelope[] {
    return this.deps.db
      .select({ runId: runEvents.runId, seq: runEvents.seq, ts: runEvents.ts, event: runEvents.event })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.seq))
      .limit(limit)
      .all();
  }

  /** Runs older than `cutoffTs` (by `endedAt`) that have reached a terminal status; their events cascade. */
  pruneEndedBefore(cutoffTs: number): number {
    const stale = this.deps.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(lt(runs.endedAt, cutoffTs), inArray(runs.status, ['succeeded', 'failed', 'stopped', 'timeout', 'rejected', 'lost'])))
      .all();
    if (stale.length === 0) return 0;
    const ids = stale.map((r) => r.id);
    this.deps.db.delete(runEvents).where(inArray(runEvents.runId, ids)).run();
    this.deps.db.delete(runs).where(inArray(runs.id, ids)).run();
    return ids.length;
  }
}
