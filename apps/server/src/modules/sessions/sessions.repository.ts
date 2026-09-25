import type { Session, TokenUsage } from '@tagconn/shared';
import { and, desc, eq, gte, inArray, lt, ne, or } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { schema } from '../../core/db/index.js';

const { sessions } = schema;
type Row = typeof sessions.$inferSelect;

const toSession = (r: Row): Session => ({
  id: r.id,
  projectId: r.projectId,
  status: r.status,
  permissionMode: r.permissionMode ?? undefined,
  startedAt: r.startedAt,
  endedAt: r.endedAt ?? undefined,
  lastPrompt: r.lastPrompt ?? undefined,
  usage: r.usage ?? undefined,
});

export class SessionsRepository {
  constructor(private readonly deps: Deps<'db'>) {}

  get(id: string): Session | undefined {
    const row = this.deps.db.select().from(sessions).where(eq(sessions.id, id)).get();
    return row && toSession(row);
  }

  upsert(s: Session, updatedAt: number): void {
    const values = {
      id: s.id,
      projectId: s.projectId,
      status: s.status,
      permissionMode: s.permissionMode ?? null,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      lastPrompt: s.lastPrompt ?? null,
      usage: s.usage ?? null,
      updatedAt,
    };
    const { id: _id, ...set } = values;
    this.deps.db.insert(sessions).values(values).onConflictDoUpdate({ target: sessions.id, set }).run();
  }

  /** Transcripts: updates only usage, without bumping updatedAt (doesn't disturb the idle/ended sweep). */
  updateUsage(id: string, usage: TokenUsage | undefined): void {
    this.deps.db.update(sessions).set({ usage: usage ?? null }).where(eq(sessions.id, id)).run();
  }

  /** Not-ended sessions plus those touched since `since`, optionally for one project. */
  listRecent(since: number, projectId?: string): Session[] {
    const recent = or(ne(sessions.status, 'ended'), gte(sessions.updatedAt, since));
    return this.deps.db
      .select()
      .from(sessions)
      .where(projectId ? and(eq(sessions.projectId, projectId), recent) : recent)
      .orderBy(desc(sessions.startedAt))
      .all()
      .map(toSession);
  }

  byIds(ids: string[]): Session[] {
    if (ids.length === 0) return [];
    return this.deps.db.select().from(sessions).where(inArray(sessions.id, ids)).all().map(toSession);
  }

  /** Not-ended sessions with no touched event since `cutoff` (idle/ended sweep candidates). */
  staleSince(cutoff: number): Session[] {
    return this.deps.db
      .select()
      .from(sessions)
      .where(and(ne(sessions.status, 'ended'), lt(sessions.updatedAt, cutoff)))
      .all()
      .map(toSession);
  }

  /** Updates only status (+ optional endedAt) without bumping updatedAt, so the idle/ended sweep
   *  doesn't reset the staleness clock it just measured. */
  setStatus(id: string, status: Session['status'], endedAt?: number): void {
    const set: Record<string, unknown> = { status };
    if (endedAt !== undefined) set.endedAt = endedAt;
    this.deps.db.update(sessions).set(set).where(eq(sessions.id, id)).run();
  }

  /** Retention: ended sessions that finished before `ts`. */
  deleteEndedBefore(ts: number): number {
    return this.deps.db
      .delete(sessions)
      .where(and(eq(sessions.status, 'ended'), lt(sessions.endedAt, ts)))
      .run().changes;
  }
}
