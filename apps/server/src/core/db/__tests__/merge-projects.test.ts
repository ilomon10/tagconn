import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { mergeNestedProjects } from '../merge-projects.js';
import { migrate } from '../migrations.js';

const project = (db: Database.Database, id: string, cwd: string, extra: { layout?: string; name?: string } = {}) =>
  db
    .prepare(`INSERT INTO projects (id, cwd, name, archived, created_at, last_activity_at, layout_id) VALUES (?, ?, ?, 0, 1, ?, ?)`)
    .run(id, cwd, extra.name ?? id, cwd.length, extra.layout ?? null);
const hero = (db: Database.Database, id: string, projectId: string, role: string, slot: number) =>
  db
    .prepare(`INSERT INTO heroes (id, project_id, role, slot, name, appearance, customized, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '{}', 0, 1, 1)`)
    .run(id, projectId, role, slot, id);

function seed() {
  const db = new Database(':memory:');
  migrate(db);
  project(db, 'root', '/w/repo', { layout: 'L1', name: 'Repo' });
  project(db, 'child', '/w/repo/apps/platform', { layout: 'L2' });
  project(db, 'grand', '/w/repo/apps/platform/pkg');
  project(db, 'other', '/w/repo-other');
  db.prepare(`INSERT INTO sessions (id, project_id, status, started_at, updated_at) VALUES ('s-child', 'child', 'active', 1, 1), ('s-grand', 'grand', 'active', 1, 1)`).run();
  db.prepare(
    `INSERT INTO agents (id, session_id, project_id, is_main, agent_type, role, status, activity, zone, started_at, updated_at) VALUES ('a1', 's-child', 'child', 0, 'x', 'developer', 'active', 'idle', 'desks', 1, 1)`,
  ).run();
  db.prepare(`INSERT INTO tasks (id, project_id, session_id, title, status, source, created_at, updated_at) VALUES ('t1', 'grand', 's-grand', 't', 'doing', 'agent-call', 1, 1)`).run();
  db.prepare(`INSERT INTO events (ts, project_id, session_id, agent_id, hook_event, summary) VALUES (1, 'child', 's-child', 'a1', 'Stop', 'x')`).run();
  hero(db, 'root-d0', 'root', 'developer', 0);
  hero(db, 'child-d0', 'child', 'developer', 0);
  hero(db, 'child-d1', 'child', 'developer', 1);
  hero(db, 'child-q0', 'child', 'qa-engineer', 0);
  hero(db, 'grand-d0', 'grand', 'developer', 0);
  return db;
}

describe('mergeNestedProjects', () => {
  it('folds nested projects into the nearest ancestor, reslots heroes, and is idempotent', () => {
    const db = seed();
    const res = mergeNestedProjects(db, { maxPerRole: 3 });
    expect(res).toEqual({ merged: 2, heroesMoved: 4, heroesDropped: 1 });

    expect(db.prepare(`SELECT id, name, layout_id FROM projects ORDER BY id`).all()).toEqual([
      { id: 'other', name: 'other', layout_id: null },
      { id: 'root', name: 'Repo', layout_id: 'L1' },
    ]);
    const ids = (sql: string) => (db.prepare(sql).all() as { project_id: string }[]).map((r) => r.project_id);
    expect(ids(`SELECT project_id FROM sessions`)).toEqual(['root', 'root']);
    expect(ids(`SELECT project_id FROM agents`)).toEqual(['root']);
    expect(ids(`SELECT project_id FROM tasks`)).toEqual(['root']);
    expect(ids(`SELECT project_id FROM events`)).toEqual(['root']);

    // grand merges into child first (slot 2 there), then child into root: one developer overflows maxPerRole.
    const heroes = db.prepare(`SELECT project_id, role, slot FROM heroes ORDER BY role, slot`).all();
    expect(heroes).toEqual([
      { project_id: 'root', role: 'developer', slot: 0 },
      { project_id: 'root', role: 'developer', slot: 1 },
      { project_id: 'root', role: 'developer', slot: 2 },
      { project_id: 'root', role: 'qa-engineer', slot: 0 },
    ]);

    expect(mergeNestedProjects(db, { maxPerRole: 3 })).toEqual({ merged: 0, heroesMoved: 0, heroesDropped: 0 });
    db.close();
  });
});
