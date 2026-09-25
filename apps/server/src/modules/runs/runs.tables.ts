import type { RunEndReason, RunEvent, RunKind, RunPermissionMode, RunResultSummary, RunModel, RunStatus } from '@tagconn/shared';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * M8 8k runner tables (S2, migration slot 6). Defined here (not in core/db/schema.ts) per
 * docs/design/runner-and-helpdesk.md §9: "Define new drizzle tables inside your module."
 * Keep the DDL in `core/db/migrations.ts` (slot 6) in sync with this shape.
 */
export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<RunKind>().notNull(),
    /** Quest floor, or the project a project-scoped receptionist conversation reads. Null = general scope. */
    projectId: text('project_id'),
    conversationId: text('conversation_id'),
    threadId: text('thread_id').notNull(),
    parentRunId: text('parent_run_id'),
    heroId: text('hero_id'),
    status: text('status').$type<RunStatus>().notNull(),
    endReason: text('end_reason').$type<RunEndReason | null>(),
    /** Redacted, truncated prompt preview (display only; the full prompt is never stored). */
    prompt: text('prompt').notNull(),
    permissionMode: text('permission_mode').$type<RunPermissionMode>().notNull(),
    model: text('model').$type<RunModel>().notNull(),
    sessionId: text('session_id'),
    resumeSessionId: text('resume_session_id'),
    createdBy: text('created_by').notNull(),
    runnerId: text('runner_id'),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    endedAt: integer('ended_at'),
    exitCode: integer('exit_code'),
    error: text('error'),
    result: text('result', { mode: 'json' }).$type<RunResultSummary | null>(),
    eventCount: integer('event_count').notNull().default(0),
    truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    index('runs_project_idx').on(t.projectId, t.createdAt),
    index('runs_thread_idx').on(t.threadId),
    index('runs_status_idx').on(t.status),
    index('runs_conversation_idx').on(t.conversationId),
    index('runs_runner_idx').on(t.runnerId, t.status),
  ],
);

/** One redacted+capped `RunEvent` per row (dedup key: `(run_id, seq)`). */
export const runEvents = sqliteTable(
  'run_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    ts: integer('ts').notNull(),
    event: text('event', { mode: 'json' }).notNull().$type<RunEvent>(),
  },
  (t) => [uniqueIndex('run_events_run_seq_idx').on(t.runId, t.seq), index('run_events_run_idx').on(t.runId, t.id)],
);
