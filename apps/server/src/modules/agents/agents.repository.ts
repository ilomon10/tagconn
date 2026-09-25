import type { Activity, Agent, AgentStatus, TokenUsage, Zone } from '@tagconn/shared';
import { and, asc, eq, isNotNull, lt, ne } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { schema } from '../../core/db/index.js';

const { agents } = schema;
type Row = typeof agents.$inferSelect;

export type AgentRecord = Agent & { removed: boolean };

const toAgent = (r: Row): AgentRecord => ({
  id: r.id,
  sessionId: r.sessionId,
  projectId: r.projectId,
  isMain: r.isMain,
  agentType: r.agentType,
  role: r.role,
  description: r.description ?? undefined,
  status: r.status as AgentStatus,
  activity: r.activity as Activity,
  zone: r.zone as Zone,
  currentTool: r.currentTool ?? undefined,
  bubble: r.bubble ?? undefined,
  lastMessage: r.lastMessage ?? undefined,
  toolCount: r.toolCount,
  usage: r.usage ?? undefined,
  startedAt: r.startedAt,
  updatedAt: r.updatedAt,
  endedAt: r.endedAt ?? undefined,
  removed: r.removed,
});

/** Strips the storage-only `removed` flag. */
export const publicAgent = ({ removed: _r, ...a }: AgentRecord): Agent => a;

export class AgentsRepository {
  constructor(private readonly deps: Deps<'db'>) {}

  get(id: string): AgentRecord | undefined {
    const row = this.deps.db.select().from(agents).where(eq(agents.id, id)).get();
    return row && toAgent(row);
  }

  upsert(a: AgentRecord): void {
    const values = {
      ...a,
      description: a.description ?? null,
      currentTool: a.currentTool ?? null,
      bubble: a.bubble ?? null,
      lastMessage: a.lastMessage ?? null,
      usage: a.usage ?? null,
      endedAt: a.endedAt ?? null,
    };
    const { id: _id, ...set } = values;
    this.deps.db.insert(agents).values(values).onConflictDoUpdate({ target: agents.id, set }).run();
  }

  /** Transcripts: updates only usage, without bumping updatedAt (doesn't disturb idle/removal sweeps). */
  updateUsage(id: string, usage: TokenUsage | undefined): void {
    this.deps.db.update(agents).set({ usage: usage ?? null }).where(eq(agents.id, id)).run();
  }

  bySession(sessionId: string): AgentRecord[] {
    return this.deps.db.select().from(agents).where(eq(agents.sessionId, sessionId)).orderBy(asc(agents.startedAt)).all().map(toAgent);
  }

  /** Agents currently on the floor (not removed), optionally of one project. */
  listLive(projectId?: string): AgentRecord[] {
    const live = eq(agents.removed, false);
    return this.deps.db
      .select()
      .from(agents)
      .where(projectId ? and(live, eq(agents.projectId, projectId)) : live)
      .orderBy(asc(agents.startedAt))
      .all()
      .map(toAgent);
  }

  /** Live, active, not yet idle agents with no update since `cutoff`. */
  staleActive(cutoff: number): AgentRecord[] {
    return this.deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.removed, false), eq(agents.status, 'active'), ne(agents.activity, 'idle'), lt(agents.updatedAt, cutoff)))
      .all()
      .map(toAgent);
  }

  /** Live agents that finished before `cutoff` (removal fallback after restarts). */
  doneBefore(cutoff: number): AgentRecord[] {
    return this.deps.db
      .select()
      .from(agents)
      .where(and(eq(agents.removed, false), eq(agents.status, 'done'), isNotNull(agents.endedAt), lt(agents.endedAt, cutoff)))
      .all()
      .map(toAgent);
  }

  /** Retention: agents already off the floor (removed) that finished before `cutoff`. */
  deleteRemovedBefore(cutoff: number): number {
    return this.deps.db
      .delete(agents)
      .where(and(eq(agents.removed, true), isNotNull(agents.endedAt), lt(agents.endedAt, cutoff)))
      .run().changes;
  }
}
