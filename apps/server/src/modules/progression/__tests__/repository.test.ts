import { defaultSettings, emptyCore, type BattleOutcome, type BattleSetup, type HeroProgressCore } from '@tagconn/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIGRATIONS, migrate } from '../../../core/db/migrations.js';
import * as schema from '../../../core/db/schema.js';
import { BattleIdCollisionError, BattlesRepository, type BattleRow } from '../battles.repository.js';
import { ProgressionRepository } from '../progression.repository.js';
import { MAX_SETUP_BYTES, SlidingWindowLimiter } from '../progression.schema.js';
import { buildTestApp, adminHeaders } from '../../../../test/helpers.js';
import type { App } from '../../../app.js';

const logger = { warn: vi.fn(), error: vi.fn() } as never;
const settings = defaultSettings();

function setup() {
  const sqlite = new Database(':memory:');
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });
  const progress = new ProgressionRepository({ db, sqlite, logger } as never);
  const battles = new BattlesRepository({ sqlite, logger } as never);
  let slot = 0;
  const addHero = (id: string, projectId = 'p1', role = 'developer') =>
    sqlite
      .prepare(`INSERT INTO heroes (id, project_id, role, slot, name, appearance, customized, created_at, updated_at) VALUES (?, ?, ?, ?, 'N', '{}', 0, 1, 1)`)
      .run(id, projectId, role, slot++);
  return { sqlite, progress, battles, addHero };
}

const core = (over: Partial<HeroProgressCore> = {}): HeroProgressCore => ({ ...emptyCore('developer', 5), ...over });
const H1 = 'h-aaaaaaaa';
const H2 = 'h-bbbbbbbb';

const row = (id: string, over: Partial<BattleRow> = {}): BattleRow => ({
  id, projectId: 'p1', status: 'open', npcKind: 'sales-dog' as never, encounterId: 'e-1', setup: { engineVersion: 1 } as unknown as BattleSetup,
  lootSeed: 7, partyHeroIds: [H1], log: null, logHash: null, outcome: null, createdAt: 1000, expiresAt: 5000, resolvedAt: null, ...over,
});

describe('migration 12', () => {
  it('applies on a fresh DB and on a v11 DB, is idempotent, and creates the indexes and columns', () => {
    const sqlite = new Database(':memory:');
    for (const sql of MIGRATIONS.slice(0, 11)) sqlite.exec(sql);
    sqlite.pragma('user_version = 11');
    expect(migrate(sqlite)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(12);
    const cols = (t: string) => (sqlite.pragma(`table_info(${t})`) as { name: string }[]).map((c) => c.name);
    expect(cols('battles')).toEqual(expect.arrayContaining(['loot_seed', 'expires_at', 'party_hero_ids', 'log_hash']));
    expect(cols('hero_progress')).toContain('equipped_title');
    expect(cols('usage_marks')).toContain('cache_creation_tokens');
    const idx = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='battles'`).all() as { name: string }[];
    expect(idx.map((i) => i.name)).toEqual(expect.arrayContaining(['battles_project_status_idx', 'battles_created_idx', 'battles_status_expires_idx']));
    expect(migrate(sqlite)).toBe(MIGRATIONS.length);
  });
});

describe('ProgressionRepository', () => {
  it('round-trips a core and upserts', () => {
    const { progress, addHero } = setup();
    addHero(H1);
    expect(progress.getCore(H1)).toEqual({ kind: 'missing' });
    const c = core({ xp: 10, skills: { 'developer.0.1': 2 }, loot: ['hat-fedora' as never] });
    expect(progress.upsertCore(H1, c)).toBe(true);
    const r = progress.getCore(H1);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect({ ...r.core, skills: { ...r.core.skills } }).toEqual({ ...c, skills: { ...c.skills } });
    expect(progress.upsertCore(H1, core({ xp: 99 }))).toBe(true);
    const r2 = progress.getCore(H1);
    expect(r2.kind === 'ok' && r2.core.xp).toBe(99);
  });

  it('upsertCore for an unknown hero returns false and inserts nothing', () => {
    const { progress, sqlite } = setup();
    expect(progress.upsertCore(H1, core())).toBe(false);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM hero_progress').get()).toEqual({ n: 0 });
  });

  it('getCore reports corrupt rows without overwriting them', () => {
    const { progress, sqlite, addHero } = setup();
    addHero(H1);
    progress.upsertCore(H1, core());
    sqlite.prepare(`UPDATE hero_progress SET skills = '{not json'`).run();
    expect(progress.getCore(H1)).toEqual({ kind: 'corrupt' });
    sqlite.prepare(`UPDATE hero_progress SET skills = '{"developer.0.1": 99}'`).run();
    expect(progress.getCore(H1)).toEqual({ kind: 'corrupt' });
    sqlite.prepare(`UPDATE hero_progress SET skills = '[]'`).run();
    expect(progress.getCore(H1)).toEqual({ kind: 'corrupt' });
    sqlite.prepare(`UPDATE hero_progress SET skills = '{}', loot = '["nope"]'`).run();
    expect(progress.getCore(H1)).toEqual({ kind: 'corrupt' });
    sqlite.prepare(`UPDATE hero_progress SET loot = '[]', class_id = 'wizard-king'`).run();
    expect(progress.getCore(H1)).toEqual({ kind: 'corrupt' });
    expect((sqlite.prepare('SELECT class_id FROM hero_progress').get() as { class_id: string }).class_id).toBe('wizard-king');
  });

  it('drops a stored __proto__ skill key without polluting, returns null-prototype skills, dedupes loot', () => {
    const { progress, sqlite, addHero } = setup();
    addHero(H1);
    progress.upsertCore(H1, core());
    sqlite
      .prepare(`UPDATE hero_progress SET skills = '{"__proto__": {"polluted": 1}, "constructor": 3, "developer.0.1": 2}', loot = '["hat-fedora","hat-fedora"]'`)
      .run();
    const r = progress.getCore(H1);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(Object.getPrototypeOf(r.core.skills)).toBeNull();
    expect(Object.keys(r.core.skills)).toEqual(['developer.0.1']);
    expect(r.core.loot).toEqual(['hat-fedora']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('pruneOrphans removes rows of deleted heroes; delete removes one', () => {
    const { progress, sqlite, addHero } = setup();
    addHero(H1);
    addHero(H2);
    progress.upsertCore(H1, core());
    progress.upsertCore(H2, core());
    sqlite.prepare('DELETE FROM heroes WHERE id = ?').run(H2);
    expect(progress.pruneOrphans()).toBe(1);
    expect(progress.getCore(H2)).toEqual({ kind: 'missing' });
    expect(progress.delete(H1)).toBe(true);
    expect(progress.delete(H1)).toBe(false);
  });

  it('listViews joins heroes (project filter, no row = not listed, corrupt skipped); view gives a default for row-less heroes', () => {
    const { progress, sqlite, addHero } = setup();
    addHero(H1, 'p1');
    addHero(H2, 'p2');
    addHero('h-cccccccc', 'p1');
    progress.upsertCore(H1, core({ xp: 3000 }));
    progress.upsertCore(H2, core({ xp: 1 }));
    expect(progress.listViews(undefined, settings).map((p) => p.heroId).sort()).toEqual([H1, H2]);
    const p1 = progress.listViews('p1', settings);
    expect(p1).toHaveLength(1);
    expect(p1[0]).toMatchObject({ heroId: H1, projectId: 'p1', xp: 3000 });
    expect(p1[0]!.level).toBeGreaterThan(1);
    expect(progress.view('h-cccccccc', settings)).toMatchObject({ level: 1, xp: 0, projectId: 'p1' });
    expect(progress.view('h-dddddddd', settings)).toBeUndefined();
    sqlite.prepare(`UPDATE hero_progress SET skills = 'x' WHERE hero_id = ?`).run(H2);
    expect(progress.listViews(undefined, settings).map((p) => p.heroId)).toEqual([H1]);
    expect(progress.view(H2, settings)).toBeUndefined();
  });

  it('marks round-trip and upsert; tx and txImmediate roll back on throw', () => {
    const { progress, sqlite } = setup();
    expect(progress.getMark('s', 'a')).toBeUndefined();
    progress.upsertMark('s', 'a', { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 }, 9);
    progress.upsertMark('s', 'a', { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheCreationTokens: 8 }, 10);
    expect(progress.getMark('s', 'a')).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheCreationTokens: 8 });
    expect(progress.getMark('s', 'b')).toBeUndefined();
    const m = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(() => progress.tx(() => (progress.upsertMark('s', 'x', m, 1), (() => { throw new Error('boom'); })()))).toThrow('boom');
    expect(progress.getMark('s', 'x')).toBeUndefined();
  });
});

describe('txImmediate', () => {
  it('takes the write lock at BEGIN (a second connection cannot write meanwhile)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagconn-tx-'));
    const path = join(dir, 'a.db');
    const sqlite = new Database(path);
    migrate(sqlite);
    const other = new Database(path, { timeout: 0 } as never);
    const repo = new ProgressionRepository({ db: drizzle(sqlite, { schema }), sqlite, logger } as never);
    const write = () => other.prepare(`INSERT INTO usage_marks VALUES ('s','a',0,0,0,0,0)`).run();
    // Nothing written yet inside the callback: a deferred BEGIN would still let the other connection in.
    repo.txImmediate(() => expect(write).toThrow(/locked|busy/i));
    repo.tx(() => expect(write).not.toThrow());
    other.close();
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('BattlesRepository', () => {
  it('round-trips a row, incl. party and null stripped fields', () => {
    const { battles } = setup();
    battles.insert(row('b-000000000001'));
    expect(battles.get('b-000000000001')).toEqual(row('b-000000000001'));
    expect(battles.get('b-nope')).toBeUndefined();
  });

  it('refuses a setup over 32 KiB and reports a PK collision distinctly', () => {
    const { battles } = setup();
    expect(() => battles.insert(row('b-000000000001', { setup: { blob: 'x'.repeat(MAX_SETUP_BYTES) } as never }))).toThrow(/too large/);
    expect(battles.get('b-000000000001')).toBeUndefined();
    battles.insert(row('b-000000000002'));
    expect(() => battles.insert(row('b-000000000002'))).toThrow(BattleIdCollisionError);
  });

  it('transition changes exactly one row, only from the expected status, and stores the patch', () => {
    const { battles } = setup();
    battles.insert(row('b-000000000001'));
    battles.insert(row('b-000000000002'));
    const outcome = { battleId: 'b-000000000001', result: 'won', turns: 3, heroes: [], loot: null, resolvedAt: 2000 } as BattleOutcome;
    expect(battles.transition('b-000000000001', 'open', 'resolved', { log: [], logHash: 'abc', outcome, resolvedAt: 2000 })).toBe(true);
    expect(battles.transition('b-000000000001', 'open', 'resolved', {})).toBe(false);
    expect(battles.get('b-000000000001')).toMatchObject({ status: 'resolved', log: [], logHash: 'abc', outcome, resolvedAt: 2000 });
    expect(battles.get('b-000000000002')!.status).toBe('open');
  });

  it('abandonOpen, abandonOpenWithHeroes and expireOpenBefore only touch open rows', () => {
    const { battles } = setup();
    battles.insert(row('b-000000000001', { projectId: 'p1', partyHeroIds: [H1] }));
    battles.insert(row('b-000000000002', { projectId: 'p2', partyHeroIds: [H1, H2] }));
    battles.insert(row('b-000000000003', { projectId: 'p2', partyHeroIds: [H2], status: 'resolved' }));
    battles.insert(row('b-000000000004', { projectId: 'p3', partyHeroIds: ['h-cccccccc'], expiresAt: 100 }));
    expect(battles.abandonOpenWithHeroes([], 1)).toBe(0);
    expect(battles.abandonOpenWithHeroes([H1], 1)).toBe(2);
    expect(battles.get('b-000000000003')!.status).toBe('resolved');
    expect(battles.abandonOpen('p3', 1)).toBe(1);
    battles.insert(row('b-000000000005', { projectId: 'p4', expiresAt: 100 }));
    battles.insert(row('b-000000000006', { projectId: 'p4', expiresAt: 99_999 }));
    expect(battles.expireOpenBefore(1000)).toBe(1);
    expect(battles.get('b-000000000005')!.status).toBe('expired');
    expect(battles.get('b-000000000006')!.status).toBe('open');
  });

  it('stripBefore keeps outcome and log_hash; prune and pruneExcess never touch open rows', () => {
    const { battles } = setup();
    const outcome = { battleId: 'x', result: 'won', turns: 1, heroes: [], loot: null, resolvedAt: 1 } as BattleOutcome;
    battles.insert(row('b-000000000001', { status: 'resolved', createdAt: 100, log: [], logHash: 'h', outcome }));
    battles.insert(row('b-000000000002', { status: 'abandoned', createdAt: 200 }));
    battles.insert(row('b-000000000003', { status: 'open', createdAt: 100 }));
    battles.insert(row('b-000000000004', { status: 'resolved', createdAt: 900, log: [], logHash: 'h2', outcome }));
    expect(battles.stripBefore(500)).toBe(2);
    expect(battles.stripBefore(500)).toBe(0);
    expect(battles.get('b-000000000001')).toMatchObject({ setup: null, log: null, logHash: 'h', outcome });
    expect(battles.get('b-000000000003')!.setup).not.toBeNull();
    expect(battles.get('b-000000000004')!.setup).not.toBeNull();
    expect(battles.prune(300)).toBe(2);
    expect(battles.get('b-000000000003')).toBeDefined();
    battles.insert(row('b-000000000005', { status: 'expired', createdAt: 910 }));
    battles.insert(row('b-000000000006', { status: 'resolved', createdAt: 920 }));
    expect(battles.pruneExcess(2)).toBe(1);
    expect(battles.get('b-000000000004')).toBeUndefined();
    expect(battles.get('b-000000000005')).toBeDefined();
    expect(battles.get('b-000000000003')).toBeDefined();
    expect(battles.pruneExcess(0)).toBe(2);
    expect(battles.get('b-000000000003')).toBeDefined();
  });
});

describe('SlidingWindowLimiter', () => {
  it('check does not record, take does, and old events leave the window', () => {
    let max = 2;
    const l = new SlidingWindowLimiter(() => max, 1000);
    expect(l.check(0)).toBe(true);
    expect(l.check(0)).toBe(true);
    expect(l.take(0)).toBe(true);
    l.record(10);
    expect(l.check(20)).toBe(false);
    expect(l.take(20)).toBe(false);
    expect(l.check(1001)).toBe(true);
    max = 1;
    expect(l.check(1005)).toBe(false);
  });
});

describe('progression module wiring', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('boots with the stub routes, registers the singletons, and the snapshot carries progress', async () => {
    app = await buildTestApp();
    const c = app.diContainer.cradle;
    expect(c.progressionRepository).toBeDefined();
    expect(c.battlesRepository).toBeDefined();
    expect(() => c.battlesService.create({ projectId: 'nope', npcKind: 'sales-dog', encounterId: 'e', party: [] } as never)).toThrow(/not found/i);
    const snap = (await app.inject({ url: '/api/snapshot' })).json<{ progress?: unknown[] }>();
    expect(snap.progress).toEqual([]);
    expect(adminHeaders(app).authorization).toBeTruthy();
  });

  it('broadcasts progress.upserted as hero:progress to the project room only', async () => {
    app = await buildTestApp();
    const emitted: unknown[] = [];
    const to = vi.spyOn(app.diContainer.cradle.office, 'to').mockImplementation(((rooms: string[]) => ({
      emit: (ev: string, p: unknown) => emitted.push({ rooms, ev, p }),
    })) as never);
    app.diContainer.cradle.bus.emit('progress.upserted', { heroId: H1, projectId: 'pA' } as never);
    expect(to).toHaveBeenCalled();
    expect(emitted).toEqual([{ rooms: expect.arrayContaining(['pA'].map((p) => expect.stringContaining(p))), ev: 'hero:progress', p: { heroId: H1, projectId: 'pA' } }]);
  });
});
