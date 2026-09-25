import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../migrations.js';

describe('migrate', () => {
  it('upgrades an existing pre-M7 DB (migrations 1-2 only) with the layouts table and projects.layout_id', () => {
    // Simulate a DB from before this module: only the first two migrations have run, with real data
    // in it, and no `layouts` table or `layout_id` column yet.
    const sqlite = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 2)) sqlite.exec(sql);
    sqlite.pragma('user_version = 2');
    sqlite.exec(
      `INSERT INTO projects (id, cwd, name, archived, created_at, last_activity_at) VALUES ('p1', '/tmp/p1', 'p1', 0, 1, 1)`,
    );
    expect(() => sqlite.exec(`SELECT layout_id FROM projects`)).toThrow();
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='layouts'`).get()).toBeUndefined();

    const version = migrate(sqlite);
    expect(version).toBe(MIGRATIONS.length);
    expect(sqlite.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);

    // The pre-existing row survives, gets a NULL layout_id, and the new table exists and is usable.
    const project = sqlite.prepare(`SELECT * FROM projects WHERE id = 'p1'`).get() as { id: string; layout_id: string | null };
    expect(project).toMatchObject({ id: 'p1', layout_id: null });
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='layouts'`).get()).toBeDefined();
    sqlite.exec(
      `INSERT INTO layouts (id, name, data, builtin, created_at, updated_at) VALUES ('default', 'Classic Hall', '{}', 1, 1, 1)`,
    );
    expect(sqlite.prepare(`SELECT id FROM layouts WHERE id = 'default'`).get()).toEqual({ id: 'default' });

    // Running migrate again is a no-op (idempotent).
    expect(migrate(sqlite)).toBe(MIGRATIONS.length);
    sqlite.close();
  });
});
