import type { Task, TaskStatus } from '@tagconn/shared';
import { and, desc, eq, gte, inArray, lt, notInArray, or } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { schema } from '../../core/db/index.js';

const { tasks } = schema;
type Row = typeof tasks.$inferSelect;

const toTask = (r: Row): Task => ({
  id: r.id,
  projectId: r.projectId,
  sessionId: r.sessionId,
  title: r.title,
  assigneeAgentId: r.assigneeAgentId ?? undefined,
  role: r.role ?? undefined,
  status: r.status as TaskStatus,
  source: r.source as Task['source'],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export class TasksRepository {
  constructor(private readonly deps: Deps<'db'>) {}

  get(id: string): Task | undefined {
    const row = this.deps.db.select().from(tasks).where(eq(tasks.id, id)).get();
    return row && toTask(row);
  }

  upsert(t: Task): void {
    const values = { ...t, assigneeAgentId: t.assigneeAgentId ?? null, role: t.role ?? null };
    const { id: _id, createdAt: _c, ...set } = values;
    this.deps.db.insert(tasks).values(values).onConflictDoUpdate({ target: tasks.id, set }).run();
  }

  bySession(sessionId: string): Task[] {
    return this.deps.db.select().from(tasks).where(eq(tasks.sessionId, sessionId)).orderBy(desc(tasks.createdAt)).all().map(toTask);
  }

  /** Most recent agent-call task assigned to an agent. */
  byAssignee(agentId: string): Task | undefined {
    const row = this.deps.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.assigneeAgentId, agentId), eq(tasks.source, 'agent-call')))
      .orderBy(desc(tasks.createdAt))
      .get();
    return row && toTask(row);
  }

  /** Open tasks plus tasks touched since `since`. */
  listRecent(since: number, projectId?: string): Task[] {
    const recent = or(notInArray(tasks.status, ['done', 'failed']), gte(tasks.updatedAt, since));
    return this.deps.db
      .select()
      .from(tasks)
      .where(projectId ? and(eq(tasks.projectId, projectId), recent) : recent)
      .orderBy(desc(tasks.updatedAt))
      .all()
      .map(toTask);
  }

  byIds(ids: string[]): Task[] {
    if (ids.length === 0) return [];
    return this.deps.db.select().from(tasks).where(inArray(tasks.id, ids)).all().map(toTask);
  }

  /** Retention: done/failed tasks last touched before `ts`. */
  deleteFinishedBefore(ts: number): number {
    return this.deps.db
      .delete(tasks)
      .where(and(inArray(tasks.status, ['done', 'failed']), lt(tasks.updatedAt, ts)))
      .run().changes;
  }
}
