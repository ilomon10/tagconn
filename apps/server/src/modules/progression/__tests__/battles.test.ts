import {
  PROGRESSION_LIMITS, applyAction, buildBattleSetup, computeOutcome, createBattle, damagePreview, emptyCore, legalActions, levelForXp,
  type BattleResult, type BattleSetup, type BattleStart, type HookPayload, type PlayerAction, type Project, type SettingsPatch,
} from '@tagconn/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../../app.js';
import { adminHeaders, buildTestApp } from '../../../../test/helpers.js';
import type { BattleRow } from '../battles.repository.js';
import { WRITE_LIMIT } from '../progression.schema.js';

const CWD_A = '/tmp/battle-project-a';
const CWD_B = '/tmp/battle-project-b';
const hook = (session: string, p: Partial<HookPayload> & { hook_event_name: string }): HookPayload => ({ session_id: session, ...p }) as HookPayload;

interface Ctx {
  app: App;
  headers: { authorization: string };
  pa: string;
  pb: string;
}

async function boot(settings: SettingsPatch = {}): Promise<Ctx> {
  const app = await buildTestApp({ settings });
  await app.inject({ method: 'POST', url: '/api/hooks', payload: hook('sa', { hook_event_name: 'SessionStart', cwd: CWD_A }) });
  await app.inject({ method: 'POST', url: '/api/hooks', payload: hook('sb', { hook_event_name: 'SessionStart', cwd: CWD_B }) });
  const projects = (await app.inject({ url: '/api/projects' })).json<Project[]>();
  const pa = projects.find((p) => p.cwd === CWD_A)?.id;
  const pb = projects.find((p) => p.cwd === CWD_B)?.id;
  if (!pa || !pb) throw new Error('projects missing');
  return { app, headers: adminHeaders(app), pa, pb };
}

async function mkHero(c: Ctx, projectId = c.pa, role = 'developer'): Promise<string> {
  const res = await c.app.inject({ method: 'POST', url: '/api/heroes', payload: { projectId, role }, headers: c.headers });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

const post = (c: Ctx, url: string, payload: unknown) => c.app.inject({ method: 'POST', url, payload: payload as object, headers: c.headers });
const create = (c: Ctx, party: unknown[], projectId = c.pa) =>
  post(c, '/api/battles', { projectId, npcKind: 'sales-dog', encounterId: 'sales-dog-1', party });
const heroRef = (heroId: string) => ({ kind: 'hero', heroId });

/** Plays the engine to its end: greedy (best damage) or a pure 'run' strategy. */
function play(setup: BattleSetup, mode: 'best' | 'weak' | 'run' = 'best'): { log: PlayerAction[]; result: BattleResult | null; turns: number } {
  let s = createBattle(setup);
  const log: PlayerAction[] = [];
  for (let guard = 0; s.phase !== 'ended' && guard < 400; guard++) {
    const legal = legalActions(setup, s);
    let pick: PlayerAction | undefined;
    if (mode === 'run') pick = legal.find((a) => a.t === 'run') ?? legal[0];
    else if (s.phase === 'choose') {
      const moves = legal.filter((a): a is Extract<PlayerAction, { t: 'move' }> => a.t === 'move');
      if (mode === 'weak') pick = moves[0];
      else pick = [...moves].sort((a, b) => (damagePreview(setup, s, b.move)?.max ?? 0) - (damagePreview(setup, s, a.move)?.max ?? 0))[0];
    }
    pick ??= legal[0];
    if (!pick) throw new Error('no legal action');
    const r = applyAction(setup, s, pick);
    if (!r.ok) throw new Error(`illegal ${r.error}`);
    s = r.state;
    log.push(pick);
  }
  return { log, result: s.result, turns: s.turn - 1 };
}

/** Stores a hand-built open battle for the given heroes; the seed is scanned until `want` is the greedy result. */
function insertBattle(c: Ctx, heroIds: string[], opts: { want?: BattleResult; id?: string; lootSeed?: number; createdAt?: number; expiresAt?: number; projectId?: string; mode?: 'best' | 'weak' | 'run'; buffEnemy?: boolean } = {}) {
  const cr = c.app.diContainer.cradle;
  const s = cr.settings.get();
  const party = heroIds.map((id) => {
    const hero = cr.heroesRepository.get(id)!;
    const read = cr.progressionRepository.getCore(id);
    const core = read.kind === 'ok' ? read.core : emptyCore(hero.role, 0);
    return { ref: heroRef(id) as never, name: hero.name, role: hero.role, xp: core.xp, skills: core.skills, temporary: false };
  });
  const curve = { levelBase: s.progression.levelBase, levelExponent: s.progression.levelExponent, maxLevel: s.progression.maxLevel };
  for (let seed = 1; seed < 400; seed++) {
    const setup = buildBattleSetup({ seed, npcKind: 'sales-dog', party, curve, difficulty: s.battle.difficulty, items: s.battle.items, maxTurns: s.battle.maxTurns });
    if (opts.buffEnemy) (setup.enemy.stats as { atk: number }).atk = 900;
    const played = play(setup, opts.mode ?? 'best');
    if (opts.want && played.result !== opts.want) continue;
    const now = opts.createdAt ?? Date.now();
    const row: BattleRow = {
      id: opts.id ?? `b-${seed.toString(16).padStart(12, '0')}`, projectId: opts.projectId ?? c.pa, status: 'open', npcKind: 'sales-dog', encounterId: 'e-1', setup,
      lootSeed: opts.lootSeed ?? 11, partyHeroIds: heroIds, log: null, logHash: null, outcome: null, createdAt: now, expiresAt: opts.expiresAt ?? now + 30 * 60_000, resolvedAt: null,
    };
    cr.battlesRepository.insert(row);
    return { row, setup, ...played };
  }
  throw new Error(`no seed gives ${opts.want}`);
}

const progressOf = (c: Ctx, heroId: string) => c.app.diContainer.cradle.progressionRepository.view(heroId, c.app.diContainer.cradle.settings.get())!;
const resolve = (c: Ctx, id: string, body: unknown) => post(c, `/api/battles/${id}/resolve`, body);
const stored = (c: Ctx, id: string) => c.app.diContainer.cradle.battlesRepository.get(id)!;

describe('battles service (M14 S3)', () => {
  let c: Ctx | undefined;
  afterEach(async () => {
    await c?.app.close();
    c = undefined;
  });

  describe('create', () => {
    it('returns 201 BattleStart without lootSeed, GET matches, row stores a numeric loot_seed', async () => {
      c = await boot();
      const h = await mkHero(c);
      const res = await create(c, [heroRef(h)]);
      expect(res.statusCode).toBe(201);
      const start = res.json<BattleStart>();
      expect(start).toMatchObject({ projectId: c.pa, npcKind: 'sales-dog', encounterId: 'sales-dog-1', status: 'open' });
      expect(start.id).toMatch(/^b-[a-f0-9]{12}$/);
      expect(res.body).not.toMatch(/lootSeed|loot_seed/i);
      expect(start.expiresAt - start.createdAt).toBe(30 * 60_000);
      const got = await c.app.inject({ url: `/api/battles/${start.id}`, headers: c.headers });
      expect(got.statusCode).toBe(200);
      expect(got.body).not.toMatch(/lootSeed|loot_seed/i);
      expect(got.json()).toMatchObject({ id: start.id, outcome: null });
      expect(typeof stored(c, start.id).lootSeed).toBe('number');
      expect(JSON.stringify(start.setup)).not.toContain(String(stored(c, start.id).lootSeed) + ',');
    });

    it('validates members: 404s, floors, duplicates, maxParty, anonymous agents', async () => {
      c = await boot({ battle: { maxParty: 2 } });
      const h1 = await mkHero(c);
      const h2 = await mkHero(c, c.pa, 'qa-engineer');
      const h3 = await mkHero(c, c.pa, 'code-reviewer');
      const hb = await mkHero(c, c.pb);
      expect((await create(c, [heroRef(h1)], 'nope')).statusCode).toBe(404);
      expect((await create(c, [heroRef('h-00000000')])).statusCode).toBe(404);
      expect((await create(c, [heroRef(hb)])).statusCode).toBe(400); // foreign floor
      expect((await create(c, [heroRef(h1), heroRef(h1)])).statusCode).toBe(400);
      expect((await create(c, [heroRef(h1), heroRef(h2), heroRef(h3)])).statusCode).toBe(400); // > maxParty
      expect((await create(c, [{ kind: 'agent', agentId: 'ghost' }])).statusCode).toBe(404);
      expect((await create(c, [heroRef(h1), heroRef(h2)])).statusCode).toBe(201);
    });

    it('anonymous agents: gated by the setting, rejected when bound to a hero, accepted otherwise', async () => {
      c = await boot();
      await c.app.inject({ method: 'POST', url: '/api/hooks', payload: hook('sa', { hook_event_name: 'SubagentStart', agent_id: 'sub-1', agent_type: 'general-purpose' }) });
      const cr = c.app.diContainer.cradle;
      const agent = cr.agentsRepository.get('sub-1');
      expect(agent).toBeDefined();
      const bound = await create(c, [{ kind: 'agent', agentId: 'sub-1' }]);
      expect(bound.statusCode).toBe(400);
      expect(bound.json().error).toMatch(/hero/);
      // Free the agent from its hero: the hero is released, the agent can fight anonymously.
      const hero = cr.heroesRepository.list(c.pa).find((x) => x.boundAgentId === 'sub-1')!;
      cr.heroesRepository.upsert({ ...hero, boundAgentId: null });
      const ok = await create(c, [{ kind: 'agent', agentId: 'sub-1' }]);
      expect(ok.statusCode).toBe(201);
      expect(ok.json<BattleStart>().setup.party[0]).toMatchObject({ temporary: true, ref: { kind: 'agent', agentId: 'sub-1' } });
      cr.settings.update({ progression: { anonymousInBattle: false } });
      expect((await create(c, [{ kind: 'agent', agentId: 'sub-1' }])).statusCode).toBe(400);
    });

    it('a knocked-out hero gets 409 with details; disabled battles get 409; a corrupt row 409', async () => {
      c = await boot();
      const cr = c.app.diContainer.cradle;
      const h = await mkHero(c);
      cr.progressionRepository.upsertCore(h, { ...emptyCore('developer', 1), koUntil: Date.now() + 60_000 });
      const ko = await create(c, [heroRef(h)]);
      expect(ko.statusCode).toBe(409);
      expect(ko.json().details).toMatchObject({ heroId: h });
      cr.progressionRepository.upsertCore(h, { ...emptyCore('developer', 1), koUntil: Date.now() - 1 });
      expect((await create(c, [heroRef(h)])).statusCode).toBe(201);
      cr.sqlite.prepare(`UPDATE hero_progress SET skills = 'not json' WHERE hero_id = ?`).run(h);
      expect((await create(c, [heroRef(h)])).statusCode).toBe(409);
      cr.settings.update({ battle: { enabled: false } });
      const off = await create(c, [heroRef(h)]);
      expect(off.statusCode).toBe(409);
      expect(off.json().error).toMatch(/disabled/i);
    });

    it('rejects unknown body keys (seed, setup, lootSeed) with 400', async () => {
      c = await boot();
      const h = await mkHero(c);
      for (const extra of [{ seed: 1 }, { setup: {} }, { lootSeed: 5 }]) {
        const res = await post(c, '/api/battles', { projectId: c.pa, npcKind: 'sales-dog', encounterId: 'e-1', party: [heroRef(h)], ...extra });
        expect(res.statusCode).toBe(400);
      }
      expect(c.app.diContainer.cradle.sqlite.prepare('SELECT COUNT(*) AS n FROM battles').get()).toEqual({ n: 0 });
    });

    it('rejects an own __proto__ key in create and resolve bodies with 400', async () => {
      c = await boot();
      const h = await mkHero(c);
      const json = { 'content-type': 'application/json', ...c.headers };
      const party = JSON.stringify([heroRef(h)]);
      const create = await c.app.inject({
        method: 'POST', url: '/api/battles', headers: json,
        payload: `{"projectId":"${c.pa}","npcKind":"sales-dog","encounterId":"e-1","party":${party},"__proto__":{"seed":1}}`,
      });
      expect(create.statusCode).toBe(400);
      const nested = await c.app.inject({
        method: 'POST', url: '/api/battles', headers: json,
        payload: `{"projectId":"${c.pa}","npcKind":"sales-dog","encounterId":"e-1","party":[{"kind":"hero","heroId":"${h}","__proto__":{}}]}`,
      });
      expect(nested.statusCode).toBe(400);
      const resolve = await c.app.inject({ method: 'POST', url: '/api/battles/b-000000000000/resolve', headers: json, payload: '{"log":[],"__proto__":{"x":1}}' });
      expect(resolve.statusCode).toBe(400);
      const expectKey = await c.app.inject({ method: 'POST', url: '/api/battles/b-000000000000/resolve', headers: json, payload: '{"log":[{"t":"run","__proto__":1}]}' });
      expect(expectKey.statusCode).toBe(400);
    });

    it('a second create on the floor abandons the first; a hero in an open battle on another floor abandons it too (F6)', async () => {
      c = await boot();
      const h1 = await mkHero(c);
      const h2 = await mkHero(c, c.pa, 'qa-engineer');
      const first = (await create(c, [heroRef(h1)])).json<BattleStart>();
      const second = (await create(c, [heroRef(h2)])).json<BattleStart>();
      expect(stored(c, first.id).status).toBe('abandoned');
      expect(stored(c, second.id).status).toBe('open');
      // h2 moves to floor B (merge); a battle on B with h2 abandons the stale one on A.
      c.app.diContainer.cradle.sqlite.prepare('UPDATE heroes SET project_id = ? WHERE id = ?').run(c.pb, h2);
      const third = await create(c, [heroRef(h2)], c.pb);
      expect(third.statusCode).toBe(201);
      expect(stored(c, second.id).status).toBe('abandoned');
      expect(stored(c, third.json<BattleStart>().id).status).toBe('open');
    });

    it('retries once on a PRIMARY KEY collision, then fails with 500', async () => {
      c = await boot();
      const h1 = await mkHero(c);
      const svc = c.app.diContainer.cradle.battlesService as unknown as { newId: () => string };
      const ids = ['b-aaaaaaaaaaaa', 'b-aaaaaaaaaaaa', 'b-bbbbbbbbbbbb'];
      const spy = vi.spyOn(svc, 'newId');
      spy.mockReturnValueOnce(ids[0]!);
      expect((await create(c, [heroRef(h1)])).json<BattleStart>().id).toBe('b-aaaaaaaaaaaa');
      spy.mockReturnValueOnce(ids[1]!).mockReturnValueOnce(ids[2]!);
      expect((await create(c, [heroRef(h1)])).json<BattleStart>().id).toBe('b-bbbbbbbbbbbb');
      spy.mockReturnValue('b-bbbbbbbbbbbb');
      const res = await create(c, [heroRef(h1)]);
      expect(res.statusCode).toBe(500);
    });

    it('maxPerHour counts only successful creates; limiters are per app instance', async () => {
      c = await boot({ battle: { maxPerHour: 2 } });
      const h = await mkHero(c);
      for (let i = 0; i < 3; i++) expect((await create(c, [heroRef(h)], 'nope')).statusCode).toBe(404); // rejected: free
      expect((await create(c, [heroRef(h)])).statusCode).toBe(201);
      expect((await create(c, [heroRef(h)])).statusCode).toBe(201);
      const limited = await create(c, [heroRef(h)]);
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ statusCode: 429 });
      const other = await boot({ battle: { maxPerHour: 2 } });
      try {
        const h2 = await mkHero(other);
        expect((await create(other, [heroRef(h2)])).statusCode).toBe(201);
      } finally {
        await other.app.close();
      }
    });
  });

  describe('resolve', () => {
    it('awards a win exactly once, identical repeat is idempotent (also after the row is stripped), another log is 409', async () => {
      c = await boot({ battle: { lootChance: 1, difficulty: 0.5, skillPointEveryWins: 1 } });
      const cr = c.app.diContainer.cradle;
      const h = await mkHero(c);
      cr.progressionRepository.upsertCore(h, { ...emptyCore('developer', 1), xp: 1400 });
      const b = insertBattle(c, [h], { want: 'won' });
      const events: unknown[] = [];
      cr.bus.on('progress.upserted', (p) => events.push(p));
      const res = await resolve(c, b.row.id, { log: b.log, expect: { result: 'won', turns: b.turns } });
      expect(res.statusCode).toBe(200);
      const outcome = res.json();
      expect(outcome).toMatchObject({ battleId: b.row.id, result: 'won', turns: b.turns });
      expect(outcome.heroes).toHaveLength(1);
      expect(outcome.heroes[0].levelAfter).toBeGreaterThan(outcome.heroes[0].levelBefore);
      expect(outcome.loot).toMatchObject({ heroId: h });
      const after = progressOf(c, h);
      expect(after).toMatchObject({ wins: 1, bonusPoints: 1 });
      expect(after.loot).toEqual([outcome.loot.lootId]);
      expect(after.xp).toBe(1400 + outcome.heroes[0].xpGained);
      expect(events).toHaveLength(1);
      expect(res.body).not.toMatch(/lootSeed|loot_seed/i);

      const repeat = await resolve(c, b.row.id, { log: b.log });
      expect(repeat.statusCode).toBe(200);
      expect(repeat.json()).toEqual(outcome);
      expect(progressOf(c, h)).toEqual(after);
      expect(events).toHaveLength(1);

      const other: PlayerAction[] = [...b.log, { t: 'run' }];
      expect((await resolve(c, b.row.id, { log: other })).statusCode).toBe(409);

      // Housekeeping a day later strips setup/log; the repeat is answered by hash + outcome only.
      cr.battlesService.housekeep(Date.now() + 25 * 3_600_000);
      expect(stored(c, b.row.id)).toMatchObject({ setup: null, log: null });
      expect(stored(c, b.row.id).logHash).toBeTruthy();
      expect((await resolve(c, b.row.id, { log: b.log })).json()).toEqual(outcome);
      expect(progressOf(c, h)).toEqual(after);
      expect((await resolve(c, b.row.id, { log: other })).statusCode).toBe(409);
      const get = await c.app.inject({ url: `/api/battles/${b.row.id}`, headers: c.headers });
      expect(get.statusCode).toBe(410);
      expect(get.json().error).toBe('battle details expired');
    });

    it('L9: a battle opened before battle/progression were disabled still resolves (create is gated, resolve is not)', async () => {
      c = await boot({ battle: { difficulty: 0.5 } });
      const cr = c.app.diContainer.cradle;
      const h = await mkHero(c);
      const b = insertBattle(c, [h], { want: 'won' });
      cr.settings.update({ battle: { enabled: false }, progression: { enabled: false } });
      const res = await resolve(c, b.row.id, { log: b.log });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ battleId: b.row.id, result: 'won' });
      const core = cr.progressionRepository.getCore(h);
      expect(core.kind === 'ok' && core.core.wins).toBe(1);
    });

    it('two concurrent resolves award once', async () => {
      c = await boot({ battle: { difficulty: 0.5 } });
      const h = await mkHero(c);
      const b = insertBattle(c, [h], { want: 'won' });
      const [r1, r2] = await Promise.all([resolve(c, b.row.id, { log: b.log }), resolve(c, b.row.id, { log: b.log })]);
      expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);
      expect(r1.json()).toEqual(r2.json());
      expect(progressOf(c, h).wins).toBe(1);
    });

    it('the lost-race path re-reads once and never replays twice', async () => {
      c = await boot({ battle: { difficulty: 0.5 } });
      const cr = c.app.diContainer.cradle;
      const h = await mkHero(c);
      const b = insertBattle(c, [h], { want: 'won' });
      const first = cr.battlesService.resolve(b.row.id, { log: b.log });
      const after = progressOf(c, h);
      const done = stored(c, b.row.id);
      const realGet = cr.battlesRepository.get.bind(cr.battlesRepository);
      const get = vi.spyOn(cr.battlesRepository, 'get');
      get.mockImplementationOnce(() => ({ ...done, status: 'open', outcome: null, logHash: null, log: null }));
      get.mockImplementation(realGet);
      const engine = (cr.battlesService as unknown as { engine: { replay: (...a: unknown[]) => unknown } }).engine;
      const realReplay = engine.replay;
      const replaySpy = vi.fn(realReplay);
      engine.replay = replaySpy;
      const second = cr.battlesService.resolve(b.row.id, { log: b.log });
      expect(second).toEqual(first);
      expect(replaySpy).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledTimes(2);
      expect(progressOf(c, h)).toEqual(after);
    });

    it('a version-mismatched setup gives 409, abandons the row, awards nothing and does not replay', async () => {
      c = await boot({ battle: { difficulty: 0.5 } });
      const cr = c.app.diContainer.cradle;
      const h = await mkHero(c);
      const b = insertBattle(c, [h], { want: 'won' });
      const old = { ...b.setup, engineVersion: 999 };
      cr.sqlite.prepare('UPDATE battles SET setup = ? WHERE id = ?').run(JSON.stringify(old), b.row.id);
      const engine = (cr.battlesService as unknown as { engine: { replay: (...a: unknown[]) => unknown } }).engine;
      const replaySpy = vi.fn(engine.replay);
      engine.replay = replaySpy;
      const res = await resolve(c, b.row.id, { log: b.log });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('engine version changed');
      expect(stored(c, b.row.id).status).toBe('abandoned');
      expect(replaySpy).not.toHaveBeenCalled();
      expect(cr.progressionRepository.getCore(h)).toEqual({ kind: 'missing' });
    });

    it('lowering openTtlMin after create does not expire early; the stored expiry does', async () => {
      c = await boot({ battle: { difficulty: 0.5 } });
      const cr = c.app.diContainer.cradle;
      const h = await mkHero(c);
      const t0 = Date.now();
      const start = cr.battlesService.create({ projectId: c.pa, npcKind: 'sales-dog', encounterId: 'e-1', party: [heroRef(h)] as never }, t0);
      expect(start.expiresAt).toBe(t0 + 30 * 60_000);
      cr.settings.update({ battle: { openTtlMin: 1 } });
      const row = stored(c, start.id);
      const fixed = play(row.setup!);
      if (fixed.result === null) throw new Error('unfinished');
      const outcome = cr.battlesService.resolve(start.id, { log: fixed.log }, t0 + 10 * 60_000);
      expect(outcome.battleId).toBe(start.id);

      const h2 = await mkHero(c, c.pa, 'qa-engineer');
      const s2 = cr.battlesService.create({ projectId: c.pa, npcKind: 'sales-dog', encounterId: 'e-1', party: [heroRef(h2)] as never }, t0);
      expect(s2.expiresAt).toBe(t0 + 60_000); // new battles use the new ttl
      const live = play(stored(c, s2.id).setup!);
      expect(() => cr.battlesService.resolve(s2.id, { log: live.log }, t0 + 61_000)).toThrow(/expired/);
      expect(stored(c, s2.id).status).toBe('expired');
    });

    it('bodies over the route bodyLimit give 413; a log over maxLog gives 400 before any replay', async () => {
      c = await boot();
      const cr = c.app.diContainer.cradle;
      const h = await mkHero(c);
      const b = insertBattle(c, [h]);
      const engine = (cr.battlesService as unknown as { engine: { replay: (...a: unknown[]) => unknown } }).engine;
      const replaySpy = vi.fn(engine.replay);
      engine.replay = replaySpy;
      const tooLong = Array.from({ length: PROGRESSION_LIMITS.maxLog + 1 }, () => ({ t: 'run' }));
      expect((await resolve(c, b.row.id, { log: tooLong })).statusCode).toBe(400);
      expect(replaySpy).not.toHaveBeenCalled();
      const huge = { log: [], pad: 'x'.repeat(33_000) };
      expect((await resolve(c, b.row.id, huge)).statusCode).toBe(413);
      const bigCreate = { projectId: c.pa, npcKind: 'sales-dog', encounterId: 'e-1', party: [], pad: 'x'.repeat(17_000) };
      expect((await post(c, '/api/battles', bigCreate)).statusCode).toBe(413);
      expect((await post(c, `/api/battles/${b.row.id}/abandon`, { pad: 'x'.repeat(17_000) })).statusCode).toBe(413);
      // Between 16 and 32 KiB is still accepted for resolve (it fails later, not with 413).
      const mid = { log: [], pad: 'x'.repeat(20_000) };
      expect((await resolve(c, b.row.id, mid)).statusCode).toBe(400);
    });

    it('replay errors give 400 {error, at}, an unfinished log 400, an expect mismatch 409; none change state', async () => {
      c = await boot({ battle: { difficulty: 0.5 } });
      const h = await mkHero(c);
      const b = insertBattle(c, [h], { want: 'won' });
      const before = progressOf(c, h);
      const bad = await resolve(c, b.row.id, { log: [{ t: 'move', move: 7 }] });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ statusCode: 400, details: { error: 'bad-move', at: 0 } });
      const unfinished = await resolve(c, b.row.id, { log: [b.log[0]] });
      expect(unfinished.statusCode).toBe(400);
      expect(unfinished.json().error).toMatch(/not finished/i);
      const desync = await resolve(c, b.row.id, { log: b.log, expect: { result: 'lost', turns: b.turns } });
      expect(desync.statusCode).toBe(409);
      expect(desync.json().details).toEqual({ result: 'won', turns: b.turns });
      const wrongTurns = await resolve(c, b.row.id, { log: b.log, expect: { result: 'won', turns: b.turns + 1 } });
      expect(wrongTurns.statusCode).toBe(409);
      expect(stored(c, b.row.id)).toMatchObject({ status: 'open', outcome: null, logHash: null });
      expect(progressOf(c, h)).toEqual(before);
      expect(c.app.diContainer.cradle.progressionRepository.getCore(h).kind).toBe('missing');
      expect((await resolve(c, b.row.id, { log: b.log })).statusCode).toBe(200);
    });

    it('a 404 for unknown battles; expired and abandoned battles give 410', async () => {
      c = await boot({ battle: { difficulty: 0.5 } });
      const h = await mkHero(c);
      expect((await resolve(c, 'b-000000000000', { log: [] })).statusCode).toBe(404);
      const now = Date.now();
      const old = insertBattle(c, [h], { want: 'won', createdAt: now - 3_600_000, expiresAt: now - 1000, id: 'b-0000000000e1' });
      const exp = await resolve(c, old.row.id, { log: old.log });
      expect(exp.statusCode).toBe(410);
      expect(stored(c, old.row.id).status).toBe('expired');
      expect((await resolve(c, old.row.id, { log: old.log })).statusCode).toBe(410);
      const b = insertBattle(c, [h], { want: 'won', id: 'b-0000000000a1' });
      expect((await post(c, `/api/battles/${b.row.id}/abandon`, {})).json()).toEqual({ status: 'abandoned' });
      expect((await resolve(c, b.row.id, { log: b.log })).statusCode).toBe(410);
    });

    it('a hero deleted mid-battle is skipped', async () => {
      c = await boot({ battle: { difficulty: 0.5 } });
      const h1 = await mkHero(c);
      const h2 = await mkHero(c, c.pa, 'qa-engineer');
      const b = insertBattle(c, [h1, h2], { want: 'won' });
      expect((await c.app.inject({ method: 'DELETE', url: `/api/heroes/${h2}`, headers: c.headers })).statusCode).toBe(204);
      const res = await resolve(c, b.row.id, { log: b.log });
      expect(res.statusCode).toBe(200);
      expect(res.json().heroes.map((a: { heroId: string }) => a.heroId)).toEqual([h1]);
      expect(c.app.diContainer.cradle.progressionRepository.getCore(h2).kind).toBe('missing');
    });

    it('a corrupt core is skipped with no award and is not overwritten', async () => {
      c = await boot({ battle: { difficulty: 0.5 } });
      const cr = c.app.diContainer.cradle;
      const h1 = await mkHero(c);
      const h2 = await mkHero(c, c.pa, 'qa-engineer');
      cr.progressionRepository.upsertCore(h2, emptyCore('qa-engineer', 1));
      cr.sqlite.prepare(`UPDATE hero_progress SET loot = 'oops' WHERE hero_id = ?`).run(h2);
      const b = insertBattle(c, [h1, h2], { want: 'won' });
      const res = await resolve(c, b.row.id, { log: b.log });
      expect(res.json().heroes.map((a: { heroId: string }) => a.heroId)).toEqual([h1]);
      expect(cr.sqlite.prepare('SELECT loot FROM hero_progress WHERE hero_id = ?').get(h2)).toEqual({ loot: 'oops' });
    });

    it('a loss KOs the party and koUntil blocks a new battle', async () => {
      c = await boot();
      const h = await mkHero(c);
      const b = insertBattle(c, [h], { want: 'lost', buffEnemy: true, mode: 'weak' });
      const res = await resolve(c, b.row.id, { log: b.log });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ result: 'lost' });
      const p = progressOf(c, h);
      expect(p.losses).toBe(1);
      expect(p.koUntil).toBeGreaterThan(Date.now());
      expect((await create(c, [heroRef(h)])).statusCode).toBe(409);
    });

    it('a flee tallies a flee and awards no XP', async () => {
      c = await boot();
      const h = await mkHero(c);
      const b = insertBattle(c, [h], { want: 'fled', mode: 'run' });
      const res = await resolve(c, b.row.id, { log: b.log });
      expect(res.json()).toMatchObject({ result: 'fled' });
      expect(progressOf(c, h)).toMatchObject({ flees: 1, xp: 0, koUntil: null });
    });

    it('the loot roll uses the stored lootSeed, not the public setup: the same log with other seeds can differ', () => {
      const setup = buildBattleSetup({
        seed: 5, npcKind: 'sales-dog', curve: { levelBase: 1500, levelExponent: 2, maxLevel: 50 }, difficulty: 1, maxTurns: 60,
        items: { coffee: 0, energyDrink: 0, rubberDuck: 0, pizza: 0 },
        party: [{ ref: { kind: 'hero', heroId: 'h-aaaaaaaa' }, name: 'A', role: 'developer', xp: 0, skills: {}, temporary: false }],
      });
      const played = play(setup);
      const r = replayFinal(setup, played.log);
      const seen = new Set<string>();
      for (let lootSeed = 1; lootSeed <= 40; lootSeed++) {
        const out = computeOutcome({
          setup, final: r, result: 'won', turns: played.turns, lootSeed, now: 1,
          heroes: [{ heroId: 'h-aaaaaaaa', memberIndex: 0, core: emptyCore('developer', 0) }],
          cfg: { curve: { levelBase: 1500, levelExponent: 2, maxLevel: 50 }, skillPointsPerLevel: 1, xpScale: 0.5, koMinutes: 5, skillPointEveryWins: 3, lootChance: 1 },
        });
        seen.add(out.loot?.lootId ?? 'none');
      }
      expect(seen.size).toBeGreaterThan(1);
    });
  });

  describe('abandon and get', () => {
    it('abandon is idempotent, 409 after resolve, 404 unknown; get 404 unknown', async () => {
      c = await boot({ battle: { difficulty: 0.5 } });
      const h = await mkHero(c);
      const start = (await create(c, [heroRef(h)])).json<BattleStart>();
      expect((await post(c, `/api/battles/${start.id}/abandon`, {})).json()).toEqual({ status: 'abandoned' });
      expect((await post(c, `/api/battles/${start.id}/abandon`, {})).json()).toEqual({ status: 'abandoned' });
      c.app.diContainer.cradle.sqlite.prepare(`UPDATE battles SET status = 'expired' WHERE id = ?`).run(start.id);
      expect((await post(c, `/api/battles/${start.id}/abandon`, {})).json()).toEqual({ status: 'expired' });
      const b = insertBattle(c, [h], { want: 'won' });
      await resolve(c, b.row.id, { log: b.log });
      expect((await post(c, `/api/battles/${b.row.id}/abandon`, {})).statusCode).toBe(409);
      expect((await post(c, '/api/battles/b-ffffffffffff/abandon', {})).statusCode).toBe(404);
      expect((await c.app.inject({ url: '/api/battles/b-ffffffffffff', headers: c.headers })).statusCode).toBe(404);
      const done = (await c.app.inject({ url: `/api/battles/${b.row.id}`, headers: c.headers })).json();
      expect(done.outcome).toMatchObject({ result: 'won' });
    });

    it('writes past WRITE_LIMIT give 429, and the limiter is not shared across apps', async () => {
      c = await boot();
      for (let i = 0; i < WRITE_LIMIT.max; i++) expect((await post(c, '/api/battles/b-ffffffffffff/abandon', {})).statusCode).toBe(404);
      const limited = await post(c, '/api/battles/b-ffffffffffff/abandon', {});
      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ statusCode: 429 });
      const other = await boot();
      try {
        expect((await post(other, '/api/battles/b-ffffffffffff/abandon', {})).statusCode).toBe(404);
      } finally {
        await other.app.close();
      }
    });
  });

  describe('housekeeping', () => {
    it('expires, strips old setup/log keeping outcome and hash, prunes by age and caps rows', async () => {
      c = await boot();
      const cr = c.app.diContainer.cradle;
      const now = Date.now();
      const day = 86_400_000;
      const stub = (id: string, over: Partial<BattleRow>): BattleRow => ({
        id, projectId: c!.pa, status: 'resolved', npcKind: 'sales-dog', encounterId: 'e', setup: { engineVersion: 1 } as unknown as BattleSetup, lootSeed: 1,
        partyHeroIds: [], log: [{ t: 'run' }], logHash: 'hash', outcome: { battleId: id, result: 'fled', turns: 1, heroes: [], loot: null, resolvedAt: now }, createdAt: now,
        expiresAt: now + 1000, resolvedAt: now, ...over,
      });
      cr.battlesRepository.insert(stub('b-00000000000a', { createdAt: now - 2 * day }));
      cr.battlesRepository.insert(stub('b-00000000000b', { createdAt: now - 40 * day }));
      cr.battlesRepository.insert(stub('b-00000000000c', { status: 'open', expiresAt: now - 5, log: null, logHash: null, outcome: null, resolvedAt: null }));
      cr.battlesRepository.insert(stub('b-00000000000d', { createdAt: now - 1000 }));
      cr.battlesService.housekeep(now);
      expect(stored(c, 'b-00000000000a')).toMatchObject({ setup: null, log: null, logHash: 'hash' });
      expect(stored(c, 'b-00000000000a').outcome).toMatchObject({ result: 'fled' });
      expect(cr.battlesRepository.get('b-00000000000b')).toBeUndefined(); // older than retentionDays (30)
      expect(stored(c, 'b-00000000000c').status).toBe('expired');
      expect(stored(c, 'b-00000000000d').setup).not.toBeNull(); // fresh: kept whole

      // Row cap: bulk-insert past maxStoredBattles, newest survive.
      const ins = cr.sqlite.prepare(
        `INSERT INTO battles (id, project_id, status, npc_kind, encounter_id, setup, loot_seed, party_hero_ids, log, log_hash, outcome, created_at, expires_at, resolved_at)
         VALUES (?, 'p', 'abandoned', 'sales-dog', 'e', '{}', 1, '[]', NULL, NULL, NULL, ?, ?, NULL)`,
      );
      cr.sqlite.transaction(() => {
        for (let i = 0; i < PROGRESSION_LIMITS.maxStoredBattles + 50; i++) ins.run(`b-f${i.toString(16).padStart(11, '0')}`, now - 10_000 + i, now);
      })();
      cr.battlesService.housekeep(now);
      const n = (cr.sqlite.prepare(`SELECT COUNT(*) AS n FROM battles WHERE status != 'open'`).get() as { n: number }).n;
      expect(n).toBe(PROGRESSION_LIMITS.maxStoredBattles);
      expect(cr.battlesRepository.get('b-00000000000d')).toBeDefined(); // newest rows are kept
    });

    it('start() runs housekeeping once and stop() clears the timer', async () => {
      c = await boot();
      const svc = c.app.diContainer.cradle.battlesService;
      const spy = vi.spyOn(svc, 'housekeep');
      svc.start();
      expect(spy).toHaveBeenCalledTimes(1);
      svc.stop();
    });
  });

  it('a scripted party-of-2 battle through REST: win, level up, loot, progress pushed', async () => {
    c = await boot({ battle: { difficulty: 0.5, lootChance: 1 } });
    const cr = c.app.diContainer.cradle;
    const h1 = await mkHero(c);
    const h2 = await mkHero(c, c.pa, 'qa-engineer');
    for (const h of [h1, h2]) cr.progressionRepository.upsertCore(h, { ...emptyCore('developer', 1), xp: 1400 });
    const pushed: string[] = [];
    cr.bus.on('progress.upserted', (p) => pushed.push(p.heroId));
    let outcome: { result: string; heroes: { levelBefore: number; levelAfter: number }[]; loot: unknown } | undefined;
    for (let attempt = 0; attempt < 30 && !outcome; attempt++) {
      const start = (await create(c, [heroRef(h1), heroRef(h2)])).json<BattleStart>();
      expect(start.setup.party).toHaveLength(2);
      const played = play(start.setup);
      const res = await resolve(c, start.id, { log: played.log, expect: { result: played.result, turns: played.turns } });
      expect(res.statusCode).toBe(200);
      if (res.json().result === 'won') outcome = res.json();
      else for (const h of [h1, h2]) cr.progressionRepository.upsertCore(h, { ...emptyCore('developer', 1), xp: 1400 });
    }
    expect(outcome).toBeDefined();
    expect(outcome!.heroes).toHaveLength(2);
    expect(outcome!.heroes.every((a) => a.levelAfter > a.levelBefore)).toBe(true);
    expect(outcome!.loot).not.toBeNull();
    expect(pushed).toEqual(expect.arrayContaining([h1, h2]));
    expect(levelForXp(progressOf(c, h1).xp, { levelBase: 1500, levelExponent: 2, maxLevel: 50 })).toBeGreaterThan(1);
  });
});

/** Final engine state of a finished log (for computeOutcome). */
function replayFinal(setup: BattleSetup, log: PlayerAction[]) {
  let s = createBattle(setup);
  for (const a of log) {
    const r = applyAction(setup, s, a);
    if (!r.ok) throw new Error(r.error);
    s = r.state;
  }
  return s;
}
