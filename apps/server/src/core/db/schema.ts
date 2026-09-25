import type { TokenUsage } from '@tagconn/shared';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Keep in sync with migrations.ts (runtime DDL; drizzle-kit is not needed at runtime).

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  cwd: text('cwd').notNull(),
  name: text('name').notNull(),
  archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  lastActivityAt: integer('last_activity_at').notNull(),
  /** Office layout of this floor (M7). Null = settings.office.defaultLayoutId. */
  layoutId: text('layout_id'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    status: text('status', { enum: ['active', 'idle', 'ended'] }).notNull(),
    permissionMode: text('permission_mode'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    lastPrompt: text('last_prompt'),
    /** Sum over the main agent and all its subagents; read from Claude Code transcripts. */
    usage: text('usage', { mode: 'json' }).$type<TokenUsage | null>(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('sessions_project_idx').on(t.projectId)],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    projectId: text('project_id').notNull(),
    isMain: integer('is_main', { mode: 'boolean' }).notNull(),
    agentType: text('agent_type').notNull(),
    role: text('role').notNull(),
    description: text('description'),
    status: text('status').notNull(),
    activity: text('activity').notNull(),
    zone: text('zone').notNull(),
    currentTool: text('current_tool'),
    bubble: text('bubble'),
    lastMessage: text('last_message'),
    toolCount: integer('tool_count').notNull().default(0),
    /** Read from this agent's Claude Code transcript (deduplicated by message id). */
    usage: text('usage', { mode: 'json' }).$type<TokenUsage | null>(),
    startedAt: integer('started_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    endedAt: integer('ended_at'),
    /** Removed from the live floor (row kept for history). */
    removed: integer('removed', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('agents_session_idx').on(t.sessionId), index('agents_live_idx').on(t.removed, t.projectId)],
);

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    title: text('title').notNull(),
    assigneeAgentId: text('assignee_agent_id'),
    role: text('role'),
    status: text('status').notNull(),
    source: text('source').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [index('tasks_project_idx').on(t.projectId, t.updatedAt), index('tasks_assignee_idx').on(t.assigneeAgentId)],
);

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    projectId: text('project_id').notNull(),
    sessionId: text('session_id').notNull(),
    agentId: text('agent_id').notNull(),
    hookEvent: text('hook_event').notNull(),
    toolName: text('tool_name'),
    activity: text('activity'),
    summary: text('summary').notNull(),
    /** Redacted tool_input/tool_response, only when settings.ingest.storeToolPayloads. */
    payload: text('payload', { mode: 'json' }),
  },
  (t) => [index('events_project_idx').on(t.projectId, t.id), index('events_ts_idx').on(t.ts)],
);

export const settingsOverrides = sqliteTable('settings_overrides', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

export const roles = sqliteTable('roles', {
  name: text('name').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  model: text('model').notNull(),
  tools: text('tools', { mode: 'json' }).$type<string[] | null>(),
  prompt: text('prompt').notNull(),
  zone: text('zone').notNull(),
  color: text('color').notNull(),
  sprite: integer('sprite').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  syncToClaude: integer('sync_to_claude', { mode: 'boolean' }).notNull(),
  builtin: integer('builtin', { mode: 'boolean' }).notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const meta = sqliteTable('meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * Office layouts (M7). `data` holds the geometry (`width, height, seed, background, corridorWidth,
 * rooms, style?`), parsed with `OfficeLayoutSchema` on read; `id`, `name`, `builtin` and the
 * timestamps are their own columns so listing and the builtin check never need to parse JSON.
 */
export const layouts = sqliteTable('layouts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  data: text('data', { mode: 'json' }).notNull(),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
