import type { ReceptionistScope, ReceptionistToolCall, RunStatus } from '@tagconn/shared';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * M8 Receptionist help desk tables (S3, migration slot 7). Defined here (not in core/db/schema.ts)
 * per docs/design/runner-and-helpdesk.md §9: "Define new drizzle tables inside your module." Keep
 * the DDL in `core/db/migrations.ts` (slot 7) in sync with this shape.
 */
export const receptionistConversations = sqliteTable(
  'receptionist_conversations',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    scope: text('scope').$type<ReceptionistScope>().notNull(),
    /** scope = "project" only: a registered project inside runner.allowedProjectDirs. */
    projectId: text('project_id'),
    /** Latest runner-created Claude session id (from `init`), used with --resume for the next turn. */
    sessionId: text('session_id'),
    /** The one in-flight run for this conversation, if any (one turn at a time). */
    activeRunId: text('active_run_id'),
    messageCount: integer('message_count').notNull().default(0),
    busy: integer('busy', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('receptionist_conversations_updated_idx').on(t.updatedAt)],
);

export const receptionistMessages = sqliteTable(
  'receptionist_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    /** Redacted. For an assistant message still streaming, the text accumulated so far. */
    text: text('text').notNull(),
    /** The run that produced (assistant) or was started by (user) this message. */
    runId: text('run_id'),
    status: text('status').$type<RunStatus | null>(),
    tools: text('tools', { mode: 'json' }).$type<ReceptionistToolCall[] | null>(),
    costUsd: real('cost_usd'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('receptionist_messages_conversation_idx').on(t.conversationId, t.createdAt), index('receptionist_messages_run_idx').on(t.runId)],
);
