import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { backupBeforeMerge, isFoldTarget, mergeNestedInto, nearestFoldTarget, normPath, pendingMergeChildren, segmentCount } from '../merge-projects.js';
import { migrate } from '../migrations.js';

interface P {
  layout?: string;
  name?: string;
  source?: 'git' | 'dir' | 'cwd' | null;
  archived?: boolean;
}
const project = (db: Database.Database, id: string, cwd: string, extra: P = {}) =>
  db
    .prepare(`INSERT INTO projects (id, cwd, name, archived, created_at, last_activity_at, layout_id, root_source) VALUES (?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(id, cwd, extra.name ?? id, extra.archived ? 1 : 0, cwd.length, extra.layout ?? null, extra.source === undefined ? 'dir' : extra.source);
const hero = (db: Database.Database, id: string, projectId: string, role: string, slot: number, bound = false) =>
  db
    .prepare(
      `INSERT INTO heroes (id, project_id, role, slot, name, appearance, customized, bound_agent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '{}', 0, ?, 1, 1)`,
    )
    .run(id, projectId, role, slot, id, bound ? `agent-${id}` : null);

const LIMITS = { maxPerRole: 3, maxPerProject: 40 };

function seed() {
  const db = new Database(':memory:');
  migrate(db);
  project(db, 'root', '/w/x/repo', { layout: 'L1', name: 'Repo', source: 'git' });
  project(db, 'child', '/w/x/repo/apps/platform', { layout: 'L2' });
  project(db, 'grand', '/w/x/repo/apps/platform/pkg', { source: 'cwd' });
  project(db, 'other', '/w/x/repo-other', { source: 'git' });
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

describe('path helpers', () => {
  it('normPath: NFC, Windows folding and trailing dots/spaces, POSIX backslash is a name char', () => {
    expect(normPath('/a//b/')).toBe('/a/b');
    expect(normPath('/a/b\\c')).toBe('/a/b\\c');
    expect(normPath('C:\\Repo\\App. \\')).toBe('c:/repo/app');
    expect(normPath('c:/Repo/app')).toBe(normPath('C:\\repo\\APP'));
    expect(normPath('/caf\u0065\u0301')).toBe('/caf\u00e9');
  });
  it('segmentCount and isFoldTarget: confirmed git, not archived, >= 3 deep', () => {
    expect(segmentCount('/home/u')).toBe(2);
    expect(segmentCount('/home/u/p')).toBe(3);
    expect(segmentCount('C:\\Users\\u')).toBe(2);
    const t = (cwd: string, extra: Partial<{ archived: boolean; rootSource: 'git' | 'dir' | 'cwd' | null }> = {}) =>
      isFoldTarget({ cwd, archived: false, rootSource: 'git', ...extra });
    expect(t('/home/u/p')).toBe(true);
    expect(t('/home/u')).toBe(false);
    expect(t('/home')).toBe(false);
    expect(t('/home/u/p', { archived: true })).toBe(false);
    expect(t('/home/u/p', { rootSource: 'dir' })).toBe(false);
    expect(t('/home/u/p', { rootSource: null })).toBe(false);
    expect(t('C:\\Users\\u\\p')).toBe(true);
    expect(t('C:\\Users')).toBe(false);
  });
  it('nearestFoldTarget skips non-targets between the child and a git ancestor', () => {
    const rows = [
      { cwd: '/w/x/repo', archived: false, rootSource: 'git' as const },
      { cwd: '/w/x/repo/apps', archived: false, rootSource: 'dir' as const },
    ];
    expect(nearestFoldTarget('/w/x/repo/apps/web', rows)?.cwd).toBe('/w/x/repo');
    expect(nearestFoldTarget('/w/x/repo', rows)).toBeUndefined();
  });
});

describe('mergeNestedInto', () => {
  it('folds non-git floors into a git root, reslots heroes under the cap, and is idempotent', () => {
    const db = seed();
    expect(pendingMergeChildren(db, 'root').map((c) => c.id)).toEqual(['grand', 'child']);
    const res = mergeNestedInto(db, 'root', LIMITS);
    expect(res).toMatchObject({ merged: 2, heroesMoved: 3, heroesDropped: 1 });
    expect(res.pairs.map((p) => [p.child.id, p.parent.id])).toEqual([['grand', 'root'], ['child', 'root']]);

    expect(db.prepare(`SELECT id, name, layout_id FROM projects ORDER BY id`).all()).toEqual([
      { id: 'other', name: 'other', layout_id: null },
      { id: 'root', name: 'Repo', layout_id: 'L1' },
    ]);
    const ids = (sql: string) => (db.prepare(sql).all() as { project_id: string }[]).map((r) => r.project_id);
    expect(ids(`SELECT project_id FROM sessions`)).toEqual(['root', 'root']);
    expect(ids(`SELECT project_id FROM agents`)).toEqual(['root']);
    expect(ids(`SELECT project_id FROM tasks`)).toEqual(['root']);
    expect(ids(`SELECT project_id FROM events`)).toEqual(['root']);
    const developers = db.prepare(`SELECT slot FROM heroes WHERE role = 'developer' ORDER BY slot`).all();
    expect(developers).toEqual([{ slot: 0 }, { slot: 1 }, { slot: 2 }]); // one released developer overflowed maxPerRole

    expect(mergeNestedInto(db, 'root', LIMITS)).toMatchObject({ merged: 0, heroesMoved: 0, heroesDropped: 0 });
    db.close();
  });

  it('never merges into a non-git, shallow or archived parent', () => {
    const db = seed();
    expect(mergeNestedInto(db, 'child', LIMITS).merged).toBe(0); // 'child' is source dir, not git
    db.prepare(`UPDATE projects SET archived = 1 WHERE id = 'root'`).run();
    expect(mergeNestedInto(db, 'root', LIMITS).merged).toBe(0);
    db.prepare(`UPDATE projects SET archived = 0 WHERE id = 'root'`).run();
    expect(mergeNestedInto(db, 'root', LIMITS).merged).toBe(2);

    const db2 = new Database(':memory:');
    migrate(db2);
    project(db2, 'home', '/home/u', { source: 'git' });
    project(db2, 'p', '/home/u/proj');
    expect(mergeNestedInto(db2, 'home', LIMITS).merged).toBe(0);
    expect(pendingMergeChildren(db2, 'home')).toEqual([]);
  });

  it('a nested git repo (and what lives inside it) stays separate', () => {
    const db = new Database(':memory:');
    migrate(db);
    project(db, 'mono', '/w/x/mono', { source: 'git' });
    project(db, 'inner', '/w/x/mono/vendor/lib', { source: 'git' });
    project(db, 'inner-sub', '/w/x/mono/vendor/lib/src', { source: 'cwd' });
    project(db, 'plain', '/w/x/mono/docs', { source: 'cwd' });
    expect(mergeNestedInto(db, 'mono', LIMITS).pairs.map((p) => p.child.id)).toEqual(['plain']);
    expect((db.prepare(`SELECT id FROM projects ORDER BY id`).all() as { id: string }[]).map((r) => r.id)).toEqual(['inner', 'inner-sub', 'mono']);
    expect(mergeNestedInto(db, 'inner', LIMITS).pairs.map((p) => p.child.id)).toEqual(['inner-sub']);
  });

  it('keeps a hero bound to a live agent even over the caps, and drops released ones first', () => {
    const db = new Database(':memory:');
    migrate(db);
    project(db, 'root', '/w/x/repo', { source: 'git' });
    project(db, 'child', '/w/x/repo/a');
    hero(db, 'r0', 'root', 'developer', 0);
    hero(db, 'c-free', 'child', 'developer', 0);
    hero(db, 'c-live', 'child', 'developer', 1, true);
    db.prepare(`INSERT INTO runs (id, kind, hero_id, thread_id, status, prompt, permission_mode, model, created_by, created_at) VALUES ('run1', 'quest', 'c-free', 't', 'done', 'p', 'plan', 'm', 'u', 1)`).run();
    const res = mergeNestedInto(db, 'root', { maxPerRole: 1, maxPerProject: 40 });
    expect(res).toMatchObject({ heroesMoved: 1, heroesDropped: 1 });
    expect(db.prepare(`SELECT id, project_id FROM heroes ORDER BY id`).all()).toEqual([
      { id: 'c-live', project_id: 'root' },
      { id: 'r0', project_id: 'root' },
    ]);
    expect(db.prepare(`SELECT hero_id FROM runs`).get()).toEqual({ hero_id: null });

    // maxPerProject binds too.
    const db2 = new Database(':memory:');
    migrate(db2);
    project(db2, 'root', '/w/x/repo', { source: 'git' });
    project(db2, 'child', '/w/x/repo/a');
    hero(db2, 'r0', 'root', 'developer', 0);
    hero(db2, 'f1', 'child', 'qa-engineer', 0);
    hero(db2, 'live', 'child', 'designer', 0, true);
    expect(mergeNestedInto(db2, 'root', { maxPerRole: 6, maxPerProject: 2 })).toMatchObject({ heroesMoved: 1, heroesDropped: 1 });
    expect((db2.prepare(`SELECT id FROM heroes ORDER BY id`).all() as { id: string }[]).map((h) => h.id)).toEqual(['live', 'r0']);
  });

  it('an archived child does not archive its live parent, and an archived parent absorbs nothing', () => {
    const db = new Database(':memory:');
    migrate(db);
    project(db, 'root', '/w/x/repo', { source: 'git' });
    project(db, 'child', '/w/x/repo/a', { archived: true });
    expect(mergeNestedInto(db, 'root', LIMITS).merged).toBe(1);
    expect(db.prepare(`SELECT archived FROM projects WHERE id = 'root'`).get()).toEqual({ archived: 0 });

    project(db, 'arch', '/w/x/old', { source: 'git', archived: true });
    project(db, 'arch-child', '/w/x/old/a');
    expect(mergeNestedInto(db, 'arch', LIMITS).merged).toBe(0);
  });
});

describe('backupBeforeMerge', () => {
  it('writes a VACUUM INTO copy, keeps the 3 newest, skips :memory:', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagconn-backup-'));
    const dbPath = join(dir, 'office.db');
    const db = new Database(dbPath);
    migrate(db);
    project(db, 'p', '/w/x/p');
    expect(backupBeforeMerge(db, ':memory:')).toBeUndefined();
    writeFileSync(join(dir, 'office.db.pre-merge-20200101T000000000Z.bak'), 'old');
    writeFileSync(join(dir, 'office.db.pre-merge-20200102T000000000Z.bak'), 'old');
    writeFileSync(join(dir, 'office.db.pre-merge-20200103T000000000Z.bak'), 'old');
    writeFileSync(join(dir, 'unrelated.bak'), 'keep');
    const file = backupBeforeMerge(db, dbPath, Date.UTC(2026, 0, 1))!;
    expect(existsSync(file)).toBe(true);
    const backups = readdirSync(dir).filter((f) => f.includes('.pre-merge-')).sort();
    expect(backups).toHaveLength(3);
    expect(backups[0]).toContain('20200102');
    expect(existsSync(join(dir, 'unrelated.bak'))).toBe(true);
    const copy = new Database(file, { readonly: true });
    expect(copy.prepare(`SELECT id FROM projects`).all()).toEqual([{ id: 'p' }]);
    copy.close();
    db.close();
  });
});
