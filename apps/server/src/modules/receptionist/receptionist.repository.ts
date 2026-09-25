import type { ReceptionistConversation, ReceptionistMessage } from '@tagconn/shared';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { Deps } from '../../core/di/index.js';
import { receptionistConversations, receptionistMessages } from './receptionist.tables.js';

type ConversationRow = typeof receptionistConversations.$inferSelect;
type MessageRow = typeof receptionistMessages.$inferSelect;

const toConversation = (r: ConversationRow): ReceptionistConversation => ({
  id: r.id,
  title: r.title,
  scope: r.scope,
  projectId: r.projectId ?? undefined,
  sessionId: r.sessionId ?? undefined,
  messageCount: r.messageCount,
  busy: r.busy,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

const toMessage = (r: MessageRow): ReceptionistMessage => ({
  id: r.id,
  conversationId: r.conversationId,
  role: r.role,
  text: r.text,
  runId: r.runId ?? undefined,
  status: r.status ?? undefined,
  tools: r.tools ?? undefined,
  costUsd: r.costUsd ?? undefined,
  createdAt: r.createdAt,
});

/** DB access for `receptionist_conversations` and `receptionist_messages` (M8 8l, S3). Never imported outside this module. */
export class ReceptionistRepository {
  constructor(private readonly deps: Deps<'db'>) {}

  // -------------------------------------------------------------- conversations

  listConversations(): ReceptionistConversation[] {
    return this.deps.db.select().from(receptionistConversations).orderBy(desc(receptionistConversations.updatedAt)).all().map(toConversation);
  }

  getConversation(id: string): ReceptionistConversation | undefined {
    const row = this.deps.db.select().from(receptionistConversations).where(eq(receptionistConversations.id, id)).get();
    return row && toConversation(row);
  }

  /** The one in-flight run for a conversation, if any (`null` = not busy / not set yet). */
  getActiveRunId(id: string): string | undefined {
    return this.deps.db.select({ activeRunId: receptionistConversations.activeRunId }).from(receptionistConversations).where(eq(receptionistConversations.id, id)).get()?.activeRunId ?? undefined;
  }

  countConversations(): number {
    return this.deps.db.select({ id: receptionistConversations.id }).from(receptionistConversations).all().length;
  }

  insertConversation(c: ReceptionistConversation): void {
    this.deps.db
      .insert(receptionistConversations)
      .values({ ...c, projectId: c.projectId ?? null, sessionId: c.sessionId ?? null, activeRunId: null })
      .run();
  }

  updateConversation(c: ReceptionistConversation, activeRunId: string | null | undefined = undefined): void {
    const { id, ...rest } = c;
    const set: Partial<typeof receptionistConversations.$inferInsert> = {
      ...rest,
      projectId: c.projectId ?? null,
      sessionId: c.sessionId ?? null,
    };
    if (activeRunId !== undefined) set.activeRunId = activeRunId;
    this.deps.db.update(receptionistConversations).set(set).where(eq(receptionistConversations.id, id)).run();
  }

  deleteConversation(id: string): boolean {
    this.deps.db.delete(receptionistMessages).where(eq(receptionistMessages.conversationId, id)).run();
    return this.deps.db.delete(receptionistConversations).where(eq(receptionistConversations.id, id)).run().changes > 0;
  }

  // -------------------------------------------------------------- messages

  listMessages(conversationId: string): ReceptionistMessage[] {
    return this.deps.db
      .select()
      .from(receptionistMessages)
      .where(eq(receptionistMessages.conversationId, conversationId))
      .orderBy(asc(receptionistMessages.createdAt))
      .all()
      .map(toMessage);
  }

  getMessage(id: string): ReceptionistMessage | undefined {
    const row = this.deps.db.select().from(receptionistMessages).where(eq(receptionistMessages.id, id)).get();
    return row && toMessage(row);
  }

  /** The assistant message a given run is building (one per run: the turn's reply). */
  getMessageByRunId(runId: string, role: 'user' | 'assistant'): ReceptionistMessage | undefined {
    const rows = this.deps.db.select().from(receptionistMessages).where(eq(receptionistMessages.runId, runId)).all();
    const row = rows.find((r) => r.role === role);
    return row && toMessage(row);
  }

  countMessages(conversationId: string): number {
    return this.deps.db.select({ id: receptionistMessages.id }).from(receptionistMessages).where(eq(receptionistMessages.conversationId, conversationId)).all().length;
  }

  insertMessage(m: ReceptionistMessage): void {
    this.deps.db
      .insert(receptionistMessages)
      .values({ ...m, runId: m.runId ?? null, status: m.status ?? null, tools: m.tools ?? null, costUsd: m.costUsd ?? null })
      .run();
  }

  updateMessage(m: ReceptionistMessage): void {
    const { id, ...rest } = m;
    this.deps.db
      .update(receptionistMessages)
      .set({ ...rest, runId: m.runId ?? null, status: m.status ?? null, tools: m.tools ?? null, costUsd: m.costUsd ?? null })
      .where(eq(receptionistMessages.id, id))
      .run();
  }

  /** Deletes the oldest messages of a conversation past `keep` (bounded history, `receptionist.
   * maxMessagesPerConversation`). Returns the number removed. */
  pruneOldestMessages(conversationId: string, keep: number): number {
    const rows = this.deps.db
      .select({ id: receptionistMessages.id })
      .from(receptionistMessages)
      .where(eq(receptionistMessages.conversationId, conversationId))
      .orderBy(asc(receptionistMessages.createdAt))
      .all();
    if (rows.length <= keep) return 0;
    const toRemove = rows.slice(0, rows.length - keep).map((r) => r.id);
    this.deps.db.delete(receptionistMessages).where(inArray(receptionistMessages.id, toRemove)).run();
    return toRemove.length;
  }
}
