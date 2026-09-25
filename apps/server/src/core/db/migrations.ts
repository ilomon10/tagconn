import type Database from 'better-sqlite3';

/**
 * Ordered, append-only migrations. `PRAGMA user_version` records how many have run.
 * Never edit an entry once shipped; add a new one instead.
 */
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, cwd TEXT NOT NULL, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, permission_mode TEXT,
    started_at INTEGER NOT NULL, ended_at INTEGER, last_prompt TEXT, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions (project_id);
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, is_main INTEGER NOT NULL,
    agent_type TEXT NOT NULL, role TEXT NOT NULL, description TEXT, status TEXT NOT NULL, activity TEXT NOT NULL,
    zone TEXT NOT NULL, current_tool TEXT, bubble TEXT, last_message TEXT, tool_count INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER, removed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS agents_session_idx ON agents (session_id);
  CREATE INDEX IF NOT EXISTS agents_live_idx ON agents (removed, project_id);
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL,
    assignee_agent_id TEXT, role TEXT, status TEXT NOT NULL, source TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks (project_id, updated_at);
  CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee_agent_id);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, project_id TEXT NOT NULL, session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL, hook_event TEXT NOT NULL, tool_name TEXT, activity TEXT, summary TEXT NOT NULL, payload TEXT
  );
  CREATE INDEX IF NOT EXISTS events_project_idx ON events (project_id, id);
  CREATE INDEX IF NOT EXISTS events_ts_idx ON events (ts);
  CREATE TABLE IF NOT EXISTS settings_overrides (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS roles (
    name TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, model TEXT NOT NULL, tools TEXT,
    prompt TEXT NOT NULL, zone TEXT NOT NULL, color TEXT NOT NULL, sprite INTEGER NOT NULL, enabled INTEGER NOT NULL,
    sync_to_claude INTEGER NOT NULL, builtin INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  /* 2: token usage read from transcripts */ `
  ALTER TABLE agents ADD COLUMN usage TEXT;
  ALTER TABLE sessions ADD COLUMN usage TEXT;
  `,
  /* 3: office layouts (M7) */ `
  CREATE TABLE IF NOT EXISTS layouts (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  ALTER TABLE projects ADD COLUMN layout_id TEXT;
  `,
  /* 4: named heroes (M8 8i) */ `
  CREATE TABLE IF NOT EXISTS heroes (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, slot INTEGER NOT NULL,
    name TEXT NOT NULL, title TEXT, appearance TEXT NOT NULL, customized INTEGER NOT NULL DEFAULT 0,
    bound_agent_id TEXT, bound_at INTEGER, released_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS heroes_project_role_slot_idx ON heroes (project_id, role, slot);
  CREATE INDEX IF NOT EXISTS heroes_bound_agent_idx ON heroes (bound_agent_id);
  `,
  // M8 slots (final order; insert your SQL string at your slot, keep this order):
  //   5: auth (S1)  6: runs (S2)  7: receptionist (S3)  8: attribution (S4)
  // Define new drizzle tables inside your module (e.g. modules/runs/runs.tables.ts), not in core/db/schema.ts.
];

export function migrate(sqlite: Database.Database): number {
  const current = sqlite.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.slice(current);
  if (pending.length === 0) return current;
  sqlite.transaction(() => {
    for (const sql of pending) sqlite.exec(sql);
    sqlite.pragma(`user_version = ${MIGRATIONS.length}`);
  })();
  return MIGRATIONS.length;
}
