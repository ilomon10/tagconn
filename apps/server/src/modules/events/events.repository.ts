import type { Activity, OfficeEvent } from '@tagconn/shared';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { schema } from '../../core/db/index.js';

const { events } = schema;
type Row = typeof events.$inferSelect;

const toEvent = (r: Row): OfficeEvent => ({
  id: r.id,
  ts: r.ts,
  projectId: r.projectId,
  sessionId: r.sessionId,
  agentId: r.agentId,
  hookEvent: r.hookEvent,
  toolName: r.toolName ?? undefined,
  activity: (r.activity as Activity | null) ?? undefined,
  summary: r.summary,
});

export type NewEvent = Omit<OfficeEvent, 'id'> & { payload?: unknown };

export class EventsRepository {
  constructor(private readonly deps: Deps<'db'>) {}

  insert(e: NewEvent): OfficeEvent {
    const row = this.deps.db
      .insert(events)
      .values({ ...e, toolName: e.toolName ?? null, activity: e.activity ?? null, payload: e.payload ?? null })
      .returning()
      .get();
    return toEvent(row);
  }

  /** Newest `limit` events (optionally before an id cursor), returned oldest → newest. */
  list(opts: { projectId?: string; limit: number; before?: number }): OfficeEvent[] {
    const conds: SQL[] = [];
    if (opts.projectId) conds.push(eq(events.projectId, opts.projectId));
    if (opts.before !== undefined) conds.push(lt(events.id, opts.before));
    return this.deps.db
      .select()
      .from(events)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(events.id))
      .limit(opts.limit)
      .all()
      .map(toEvent)
      .reverse();
  }

  deleteOlderThan(ts: number): number {
    return this.deps.db.delete(events).where(lt(events.ts, ts)).run().changes;
  }
}
