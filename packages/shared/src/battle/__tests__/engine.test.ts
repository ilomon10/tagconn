import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROGRESSION_LIMITS } from '../../progression.js';
import { applyAction, createBattle, damagePreview, legalActions, replay, rngNext, seedState } from '../engine.js';
import { ENGINE_VERSION, type BattleActionError, type BattleEvent, type BattleSetup, type BattleState, type PlayerAction } from '../types.js';
import { COFFEE, M, MOVE0, deepFreeze, enemy, hero, mv, setup, stats, testRng } from './fixtures.js';

function must(r: ReturnType<typeof applyAction>) {
  if (!r.ok) throw new Error(`unexpected error ${r.error}`);
  return r;
}
const err = (s: BattleSetup, st: BattleState, a: PlayerAction): BattleActionError | null => {
  const r = applyAction(s, st, a);
  return r.ok ? null : r.error;
};
const kinds = (ev: BattleEvent[]) => ev.map((e) => e.k);
/** An enemy with a single harmless basic move, to isolate what a test checks. */
const quietEnemy = (o: Parameters<typeof enemy>[0] = {}) => enemy({ moves: [mv('poke', { power: 1 })], ...o });

describe('createBattle', () => {
  it('starts at full hp and focus with the seeded stream', () => {
    const su = setup();
    const s = createBattle(su);
    expect(s).toMatchObject({ turn: 1, phase: 'choose', active: 0, result: null, actions: 0, runAttempts: 0, items: [2, 1, 1, 1] });
    expect(s.rng).toBe(seedState(su.seed, 0x9e3779b9));
    expect(s.party.map((p) => [p.hp, p.focus])).toEqual([[60, 40], [60, 40]]);
    expect(s.enemy.hp).toBe(90);
  });
});

describe('validation', () => {
  const su = setup();
  const s0 = createBattle(su);
  it('reaches every error code', () => {
    expect(err(su, s0, { t: 'move', move: 99 })).toBe('bad-move');
    expect(err(su, s0, { t: 'move', move: -1 })).toBe('bad-move');
    expect(err(su, { ...s0, party: [{ ...s0.party[0]!, focus: 0 }, s0.party[1]!] }, { t: 'move', move: 1 })).toBe('no-focus');
    expect(err(su, s0, { t: 'item', item: 9 })).toBe('bad-item');
    expect(err(su, { ...s0, items: [0, 1, 1, 1] }, { t: 'item', item: 0 })).toBe('no-item');
    expect(err(su, s0, { t: 'item', item: 0, target: 3 })).toBe('bad-target');
    expect(err(su, s0, { t: 'swap', to: 0 })).toBe('bad-swap');
    expect(err(su, s0, { t: 'swap', to: 3 })).toBe('bad-swap');
    expect(err({ ...su, engineVersion: ENGINE_VERSION + 1 }, s0, MOVE0)).toBe('version');
    expect(err(su, { ...s0, phase: 'forced-swap' }, MOVE0)).toBe('swap-required');
    expect(err(su, { ...s0, phase: 'ended', result: 'won' }, MOVE0)).toBe('ended');
  });
  it('a bad action changes nothing and draws nothing', () => {
    const before = JSON.stringify(s0);
    applyAction(su, s0, { t: 'move', move: 99 });
    expect(JSON.stringify(s0)).toBe(before);
  });
  it('rejects a swap to a fainted member and an item on a fainted target', () => {
    const st = { ...s0, party: [s0.party[0]!, { ...s0.party[1]!, hp: 0, fainted: true }] };
    expect(err(su, st, { t: 'swap', to: 1 })).toBe('bad-swap');
    expect(err(su, st, { t: 'item', item: 0, target: 1 })).toBe('bad-target');
  });
  it('run is always legal', () => expect(err(su, s0, { t: 'run' })).toBeNull());
  it('actions after the end are rejected and replay reports the index', () => {
    const one = setup({ party: [hero()], enemy: quietEnemy({ stats: stats({ hp: 1 }) }) });
    const r = replay(one, [MOVE0]);
    expect(r).toMatchObject({ ok: true, result: 'won', turns: 1 });
    expect(replay(one, [MOVE0, MOVE0])).toEqual({ ok: false, error: 'ended', at: 1 });
    expect(replay(setup(), [MOVE0, { t: 'move', move: 77 }])).toEqual({ ok: false, error: 'bad-move', at: 1 });
  });
  it('a tampered log changes the outcome or fails', () => {
    const a = replay(setup(), [MOVE0, MOVE0, { t: 'move', move: 1 }, MOVE0]);
    const b = replay(setup(), [MOVE0, MOVE0, { t: 'move', move: 0 }, MOVE0]);
    expect(a.ok && b.ok && JSON.stringify(a.state) === JSON.stringify(b.state)).toBe(false);
    expect(replay(setup(), [MOVE0, { t: 'move', move: 9 }, MOVE0, MOVE0]).ok).toBe(false);
  });
});

describe('turn rules', () => {
  it('the faster actor goes first; priority beats speed', () => {
    const fast = setup({ party: [hero({ stats: stats({ spd: 50 }) })], enemy: quietEnemy() });
    let r = must(applyAction(fast, createBattle(fast), MOVE0));
    expect(r.events.filter((e) => e.k === 'use').map((e) => (e as { by: { side: string } }).by.side)).toEqual(['party', 'enemy']);
    const slow = setup({ party: [hero({ stats: stats({ spd: 10 }) })], enemy: quietEnemy() });
    r = must(applyAction(slow, createBattle(slow), MOVE0));
    expect(r.events.filter((e) => e.k === 'use').map((e) => (e as { by: { side: string } }).by.side)).toEqual(['enemy', 'party']);
    r = must(applyAction(slow, createBattle(slow), { t: 'move', move: 5 }));
    expect(r.events.filter((e) => e.k === 'use').map((e) => (e as { by: { side: string } }).by.side)).toEqual(['party', 'enemy']);
  });
  it('a speed tie is broken by a draw and both orders occur', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 40; seed++) {
      const su = setup({ seed, party: [hero({ stats: stats({ spd: 30 }) })], enemy: quietEnemy({ stats: stats({ spd: 30 }) }) });
      const r = must(applyAction(su, createBattle(su), MOVE0));
      seen.add((r.events.find((e) => e.k === 'use') as { by: { side: string } }).by.side);
    }
    expect(seen.size).toBe(2);
  });
  it('swap, item and run go before the enemy', () => {
    const su = setup({ party: [hero({ stats: stats({ spd: 1 }) }), hero()], enemy: quietEnemy({ stats: stats({ spd: 99 }) }) });
    for (const a of [{ t: 'swap', to: 1 }, { t: 'item', item: 0 }] as PlayerAction[]) {
      const ev = must(applyAction(su, createBattle(su), a)).events;
      expect(kinds(ev).indexOf(a.t === 'swap' ? 'swap' : 'item')).toBeLessThan(kinds(ev).indexOf('use'));
    }
  });
  it('super-effective damage >= neutral >= weak for the same draws', () => {
    const dmg = (type: 'bug' | 'rival' | 'feral') => {
      const su = setup({ party: [hero({ type: 'test', moves: [mv('assert', { type: 'test', power: 50 })], stats: stats({ spd: 99 }) })], enemy: quietEnemy({ type }) });
      const r = must(applyAction(su, createBattle(su), MOVE0));
      return r.events.find((e) => e.k === 'damage') as Extract<BattleEvent, { k: 'damage' }>;
    };
    const sup = dmg('bug');
    const norm = dmg('feral');
    const weak = dmg('rival');
    expect([sup.eff, norm.eff, weak.eff]).toEqual(['super', 'normal', 'weak']);
    expect(sup.amount).toBeGreaterThanOrEqual(norm.amount);
    expect(norm.amount).toBeGreaterThanOrEqual(weak.amount);
    expect(sup.amount).toBeGreaterThan(weak.amount);
  });
  it('damage is at least 1 and STAB/shield/buff apply', () => {
    const tiny = setup({ party: [hero({ stats: stats({ atk: 1, spd: 99 }), moves: [mv('p', { power: 1 })] })], enemy: quietEnemy({ stats: stats({ def: 999 }) }) });
    const ev = must(applyAction(tiny, createBattle(tiny), MOVE0)).events.find((e) => e.k === 'damage') as Extract<BattleEvent, { k: 'damage' }>;
    expect(ev.amount).toBe(1);
    const prev = (st: BattleState) => damagePreview(setup({ party: [hero({ stats: stats({ spd: 99 }) })], enemy: quietEnemy() }), st, 0)!;
    const su = setup({ party: [hero()], enemy: quietEnemy() });
    const base = createBattle(su);
    const stab = damagePreview(su, base, 0)!;
    const noStab = damagePreview(setup({ party: [hero({ type: 'test' })], enemy: quietEnemy() }), base, 0)!;
    expect(stab.max).toBeGreaterThan(noStab.max);
    expect(prev({ ...base, enemy: { ...base.enemy, shieldTurns: 2 } }).max).toBeLessThan(prev(base).max);
    expect(prev({ ...base, party: [{ ...base.party[0]!, buffTurns: 2 }, base.party[1]!] }).max).toBeGreaterThan(prev(base).max);
    expect(damagePreview(su, base, 2)).toBeNull();
    expect(damagePreview(su, base, 50)).toBeNull();
  });
  it('multi-hit moves emit one damage event per hit and stop on faint', () => {
    const su = setup({ party: [hero({ stats: stats({ spd: 99 }), moves: [M.multi] })], enemy: quietEnemy() });
    const ev = must(applyAction(su, createBattle(su), MOVE0)).events.filter((e) => e.k === 'damage' && e.target.side === 'enemy');
    expect(ev.length).toBeLessThanOrEqual(3);
    const weakE = setup({ party: [hero({ stats: stats({ spd: 99 }), moves: [M.multi] })], enemy: quietEnemy({ stats: stats({ hp: 1 }) }) });
    let hits = 0;
    for (let seed = 0; seed < 20; seed++) {
      const r = must(applyAction({ ...weakE, seed }, createBattle({ ...weakE, seed }), MOVE0));
      hits += r.events.filter((e) => e.k === 'damage').length;
      expect(r.state.result).toBe(r.events.some((e) => e.k === 'miss') ? null : 'won');
    }
    expect(hits).toBeGreaterThan(0);
  });
  it('accuracy misses happen and never at 100', () => {
    let miss = 0;
    for (let seed = 0; seed < 200; seed++) {
      const su = setup({ seed, party: [hero({ stats: stats({ spd: 99 }), moves: [mv('x', { accuracy: 50 })] })], enemy: quietEnemy() });
      if (must(applyAction(su, createBattle(su), MOVE0)).events.some((e) => e.k === 'miss' && e.by.side === 'party')) miss++;
    }
    expect(miss).toBeGreaterThan(60);
    expect(miss).toBeLessThan(140);
    for (let seed = 0; seed < 100; seed++) {
      const su = setup({ seed, party: [hero({ stats: stats({ spd: 99 }) })], enemy: quietEnemy() });
      expect(must(applyAction(su, createBattle(su), MOVE0)).events.some((e) => e.k === 'miss')).toBe(false);
    }
  });
  it('focus is spent, regenerates (+focusRegen) and caps', () => {
    const su = setup({ party: [hero({ mods: { critPct: 0, focusRegen: 3, statusResistPct: 0, healBoostPct: 0, typeBoostPct: 0 } })], enemy: quietEnemy() });
    const r = must(applyAction(su, createBattle(su), { t: 'move', move: 1 }));
    expect(r.state.party[0]!.focus).toBe(40 - 8 + 5);
    const full = must(applyAction(su, createBattle(su), MOVE0));
    expect(full.state.party[0]!.focus).toBe(40);
  });
});

describe('heals, items, swaps', () => {
  const su = setup({ enemy: quietEnemy({ stats: stats({ spd: 1 }) }) });
  const hurt = (hp0: number, hp1: number): BattleState => {
    const s = createBattle(su);
    return { ...s, party: [{ ...s.party[0]!, hp: hp0 }, { ...s.party[1]!, hp: hp1 }] };
  };
  it('coffee heals 40% of max, capped, to the target, and is consumed', () => {
    const r = must(applyAction(su, hurt(10, 30), { t: 'item', item: 0, target: 1 }));
    expect(r.state.party[1]!.hp).toBe(54);
    expect(r.events.find((e) => e.k === 'heal')).toMatchObject({ amount: 24, hp: 54, target: { side: 'party', index: 1 } });
    expect(r.state.items[0]).toBe(1);
    const capped = must(applyAction(su, hurt(50, 60), { t: 'item', item: 0 }));
    expect(capped.events.find((e) => e.k === 'heal')).toMatchObject({ amount: 10, hp: 60 });
  });
  it('pizza heals every living member, energy drink restores focus, rubber duck cures', () => {
    const r = must(applyAction(su, hurt(10, 10), { t: 'item', item: 3 }));
    expect(r.events.filter((e) => e.k === 'heal')).toHaveLength(2);
    const s = hurt(10, 10);
    s.party[1] = { ...s.party[1]!, hp: 0, fainted: true };
    expect(must(applyAction(su, s, { t: 'item', item: 3 })).events.filter((e) => e.k === 'heal')).toHaveLength(1);
    const f = hurt(60, 60);
    f.party[0] = { ...f.party[0]!, focus: 0 };
    expect(must(applyAction(su, f, { t: 'item', item: 1 })).events.find((e) => e.k === 'focus')).toMatchObject({ amount: 20 });
    const c = hurt(60, 60);
    c.party[0] = { ...c.party[0]!, status: 'burnout', statusTurns: 4 };
    const cured = must(applyAction(su, c, { t: 'item', item: 2 }));
    expect(cured.events).toContainEqual({ k: 'status', target: { side: 'party', index: 0 }, status: 'burnout', on: false });
    expect(cured.state.party[0]!.status).toBeNull();
  });
  it('heal moves use healBoostPct; party heal skips fainted members', () => {
    const boosted = setup({ party: [hero({ mods: { critPct: 0, focusRegen: 0, statusResistPct: 0, healBoostPct: 50, typeBoostPct: 0 }, moves: [M.basic, M.partyHeal, M.heal] }), hero()], enemy: quietEnemy({ stats: stats({ spd: 1 }) }) });
    const s = createBattle(boosted);
    s.party[0] = { ...s.party[0]!, hp: 1 };
    s.party[1] = { ...s.party[1]!, hp: 0, fainted: true };
    const r = must(applyAction(boosted, s, { t: 'move', move: 1 }));
    expect(r.events.filter((e) => e.k === 'heal')).toEqual([{ k: 'heal', target: { side: 'party', index: 0 }, amount: 27, hp: 28 }]);
    const one = must(applyAction(boosted, s, { t: 'move', move: 2 }));
    expect(one.events.find((e) => e.k === 'heal')).toMatchObject({ amount: 36 });
  });
  it('a swap clears buff and shield but keeps the major status', () => {
    const s = createBattle(su);
    s.party[0] = { ...s.party[0]!, shieldTurns: 3, buffTurns: 3, status: 'burnout', statusTurns: 4 };
    const r = must(applyAction(su, s, { t: 'swap', to: 1 }));
    expect(r.state.active).toBe(1);
    expect(r.state.party[0]).toMatchObject({ shieldTurns: 0, buffTurns: 0, status: 'burnout', statusTurns: 4 });
    expect(r.events).toContainEqual({ k: 'status', target: { side: 'party', index: 0 }, status: 'shielded', on: false });
  });
  it('a shield move halves the next hit and expires', () => {
    const sh = setup({ party: [hero({ stats: stats({ spd: 99 }) })], enemy: enemy({ stats: stats({ hp: 99, spd: 1 }), moves: [mv('hit', { power: 60 })] }) });
    const s1 = must(applyAction(sh, createBattle(sh), { t: 'move', move: 3 })).state;
    expect(s1.party[0]!.shieldTurns).toBe(2);
    const bare = must(applyAction(sh, createBattle(sh), MOVE0));
    const shielded = must(applyAction(sh, createBattle(sh), { t: 'move', move: 3 }));
    const dmgOf = (ev: BattleEvent[]) => (ev.find((e) => e.k === 'damage' && e.target.side === 'party') as Extract<BattleEvent, { k: 'damage' }>).amount;
    expect(dmgOf(shielded.events)).toBeLessThanOrEqual(Math.ceil(dmgOf(bare.events) / 2) + 1);
    let st = s1;
    for (let i = 0; i < 2; i++) st = must(applyAction(sh, st, MOVE0)).state;
    expect(st.party[0]!.shieldTurns).toBe(0);
  });
});

describe('faint, forced swap, end', () => {
  const lethal = () => setup({ party: [hero({ stats: stats({ hp: 5, spd: 1 }) }), hero()], enemy: enemy({ stats: stats({ atk: 200, hp: 500, spd: 99 }), moves: [mv('smash', { power: 120 })] }) });
  it('requires a swap, which costs no turn and gives the enemy no action', () => {
    const su = lethal();
    const r1 = must(applyAction(su, createBattle(su), MOVE0));
    expect(r1.state.phase).toBe('forced-swap');
    expect(r1.state.party[0]).toMatchObject({ fainted: true, hp: 0 });
    expect(err(su, r1.state, MOVE0)).toBe('swap-required');
    expect(err(su, r1.state, { t: 'run' })).toBe('swap-required');
    expect(err(su, r1.state, { t: 'swap', to: 0 })).toBe('bad-swap');
    expect(legalActions(su, r1.state)).toEqual([{ t: 'swap', to: 1 }]);
    const r2 = must(applyAction(su, r1.state, { t: 'swap', to: 1 }));
    expect(r2.events).toEqual([{ k: 'swap', from: 0, to: 1, forced: true }]);
    expect(r2.state.turn).toBe(r1.state.turn);
    expect(r2.state.phase).toBe('choose');
    expect(r2.state.enemy).toEqual(r1.state.enemy);
  });
  it('losing the last member ends with lost; the turn counter counts played turns', () => {
    const su = setup({ party: [hero({ stats: stats({ hp: 5, spd: 1 }) })], enemy: lethal().enemy });
    const r = replay(su, [MOVE0]);
    expect(r).toMatchObject({ ok: true, result: 'lost', turns: 1 });
    expect(r.ok && r.events.map((e) => e.k).slice(-2)).toEqual(['faint', 'end']);
  });
  it('a win ends the battle at once (the enemy does not act after dying)', () => {
    const su = setup({ party: [hero({ stats: stats({ spd: 99, atk: 200 }) })], enemy: quietEnemy({ stats: stats({ hp: 3 }) }) });
    const r = must(applyAction(su, createBattle(su), MOVE0));
    expect(r.state).toMatchObject({ phase: 'ended', result: 'won' });
    expect(r.events.filter((e) => e.k === 'use')).toHaveLength(1);
  });
  it('a hero that fainted this turn does not act', () => {
    const su = setup({ party: [hero({ stats: stats({ hp: 5, spd: 1 }) }), hero()], enemy: lethal().enemy });
    const r = must(applyAction(su, createBattle(su), MOVE0));
    expect(r.events.filter((e) => e.k === 'use')).toHaveLength(1);
  });
  it('run ends fled on success and the odds grow with every failed attempt', () => {
    const results = new Set<boolean>();
    for (let seed = 0; seed < 60; seed++) {
      const su = setup({ seed, party: [hero({ stats: stats({ spd: 30 }) })], enemy: quietEnemy({ stats: stats({ spd: 30 }) }) });
      const r = must(applyAction(su, createBattle(su), { t: 'run' }));
      const run = r.events.find((e) => e.k === 'run') as { ok: boolean };
      results.add(run.ok);
      if (run.ok) {
        expect(r.state).toMatchObject({ phase: 'ended', result: 'fled' });
        expect(r.events.some((e) => e.k === 'use')).toBe(false);
      } else {
        expect(r.state.runAttempts).toBe(1);
        expect(r.events.some((e) => e.k === 'use')).toBe(true);
      }
    }
    expect(results.size).toBe(2);
    const sure = setup({ party: [hero({ stats: stats({ spd: 200 }) })], enemy: quietEnemy() });
    const s = createBattle(sure);
    s.runAttempts = 10; // clamps at 95
    let fled = 0;
    for (let seed = 0; seed < 100; seed++) if (must(applyAction({ ...sure, seed }, { ...s, rng: seedState(seed, 1) }, { t: 'run' })).state.result === 'fled') fled++;
    expect(fled).toBeGreaterThan(85);
    expect(fled).toBeLessThan(100);
  });
  it('ends with timeout after maxTurns and a 200-turn stall fits the stored log limit', () => {
    const su = setup({ maxTurns: 200, party: [hero({ moves: [mv('tap', { power: 1 })] }), hero(), hero(), hero()], enemy: quietEnemy({ stats: stats({ hp: 99999, def: 9999 }), moves: [mv('tap', { power: 1 })] }) });
    // a hero with 99999 hp that is never hit hard: heal with the potion-free move set
    su.party[0]!.stats = stats({ hp: 99999 });
    const log: PlayerAction[] = Array.from({ length: 200 }, () => MOVE0);
    const r = replay(su, log);
    expect(r).toMatchObject({ ok: true, result: 'timeout', turns: 200 });
    expect(200 + 4).toBeLessThanOrEqual(PROGRESSION_LIMITS.maxLog);
  });
});

describe('statuses', () => {
  const slowEnemy = (o: Parameters<typeof enemy>[0] = {}) => quietEnemy({ stats: stats({ spd: 1, hp: 999 }), ...o });
  it('stun skips exactly one enemy action', () => {
    const stunner = setup({ party: [hero({ stats: stats({ spd: 99 }), moves: [M.stun, M.basic] })], enemy: slowEnemy() });
    const a = must(applyAction(stunner, createBattle(stunner), MOVE0));
    expect(a.events.filter((e) => e.k === 'skip')).toEqual([{ k: 'skip', by: { side: 'enemy' }, reason: 'stunned' }]);
    expect(a.state.enemy.status).toBeNull();
    const b = must(applyAction(stunner, a.state, { t: 'move', move: 1 }));
    expect(b.events.some((e) => e.k === 'skip')).toBe(false);
    expect(b.events.some((e) => e.k === 'use' && e.by.side === 'enemy')).toBe(true);
  });
  it('stun persists to the next turn when applied after the target acted', () => {
    const su = setup({ party: [hero({ stats: stats({ spd: 1 }), moves: [M.stun] })], enemy: quietEnemy({ stats: stats({ spd: 99, hp: 999 }) }) });
    const a = must(applyAction(su, createBattle(su), MOVE0));
    expect(a.state.enemy.status).toBe('stunned');
    const b = must(applyAction(su, a.state, MOVE0));
    expect(b.events.filter((e) => e.k === 'skip')).toHaveLength(1);
  });
  it('a stunned hero skips and the status clears', () => {
    const su = setup({ enemy: slowEnemy() });
    const s = createBattle(su);
    s.party[0] = { ...s.party[0]!, status: 'stunned', statusTurns: 1 };
    const r = must(applyAction(su, s, MOVE0));
    expect(r.events.find((e) => e.k === 'skip')).toEqual({ k: 'skip', by: { side: 'party', index: 0 }, reason: 'stunned' });
    expect(r.state.party[0]!.status).toBeNull();
    expect(r.events.some((e) => e.k === 'use' && e.by.side === 'party')).toBe(false);
  });
  it('an enemy stunned at turn start makes no intent draws', () => {
    const su = setup({ party: [hero({ stats: stats({ spd: 99 }) })], enemy: slowEnemy() });
    const s = createBattle(su);
    s.enemy = { ...s.enemy, status: 'stunned', statusTurns: 1 };
    const r = must(applyAction(su, s, { t: 'move', move: 3 })); // shield: no draws of its own
    expect(r.state.rng).toBe(s.rng);
  });
  it('merge-conflict self-hits about a third of the time and loses the action', () => {
    const su = setup({ enemy: slowEnemy() });
    let hits = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const s = createBattle(su);
      s.rng = (i * 2654435761) >>> 0;
      s.party[0] = { ...s.party[0]!, status: 'merge-conflict', statusTurns: 9 };
      const r = must(applyAction(su, s, MOVE0));
      const confused = r.events.some((e) => e.k === 'confused');
      if (confused) {
        hits++;
        expect(r.events.some((e) => e.k === 'damage' && e.selfHit && e.target.side === 'party')).toBe(true);
        expect(r.events.some((e) => e.k === 'use' && e.by.side === 'party')).toBe(false);
      }
    }
    expect(hits / N).toBeGreaterThan(0.28);
    expect(hits / N).toBeLessThan(0.38);
  });
  it('burnout ticks max(1, hp/12) for the active hero then the enemy, then wears off', () => {
    const su = setup({ party: [hero({ stats: stats({ hp: 60 }) })], enemy: slowEnemy({ stats: stats({ hp: 120, spd: 1 }) }) });
    const s = createBattle(su);
    s.party[0] = { ...s.party[0]!, status: 'burnout', statusTurns: 2 };
    s.enemy = { ...s.enemy, status: 'burnout', statusTurns: 1 };
    const r = must(applyAction(su, s, { t: 'move', move: 3 }));
    const ticks = r.events.filter((e) => e.k === 'damage' && e.amount >= 5 && !e.selfHit && e.crit === false && e.eff === 'normal');
    expect(ticks).toContainEqual(expect.objectContaining({ target: { side: 'party', index: 0 }, amount: 5 }));
    expect(ticks).toContainEqual(expect.objectContaining({ target: { side: 'enemy' }, amount: 10 }));
    expect(r.state.enemy.status).toBeNull();
    expect(r.state.party[0]).toMatchObject({ status: 'burnout', statusTurns: 1 });
    const r2 = must(applyAction(su, r.state, { t: 'move', move: 3 }));
    expect(r2.state.party[0]!.status).toBeNull();
    const tiny = setup({ party: [hero({ stats: stats({ hp: 5 }) })], enemy: slowEnemy() });
    const ts = createBattle(tiny);
    ts.party[0] = { ...ts.party[0]!, status: 'burnout', statusTurns: 3 };
    expect(must(applyAction(tiny, ts, { t: 'move', move: 3 })).events).toContainEqual(expect.objectContaining({ target: { side: 'party', index: 0 }, amount: 1 }));
  });
  it('burnout can finish the enemy', () => {
    const su = setup({ party: [hero({ stats: stats({ spd: 99 }) })], enemy: slowEnemy({ stats: stats({ hp: 12, spd: 1 }) }) });
    const s = createBattle(su);
    s.enemy = { ...s.enemy, hp: 1, status: 'burnout', statusTurns: 3 };
    const r = must(applyAction(su, s, { t: 'move', move: 3 }));
    expect(r.state.result).toBe('won');
  });
  it('status durations stay in range and are drawn only for ranges', () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 60; seed++) {
      const su = setup({ seed, party: [hero({ stats: stats({ spd: 99 }), moves: [M.conflict] })], enemy: slowEnemy() });
      const r = must(applyAction(su, createBattle(su), MOVE0));
      // applied for 2..3 turns, then one end-of-turn tick
      seen.add(r.state.enemy.statusTurns);
    }
    expect([...seen].sort()).toEqual([1, 2]);
  });
  it('resist blocks the status; chance < 100 sometimes fails; a status is not stacked', () => {
    const res = setup({ party: [hero({ stats: stats({ spd: 99 }), moves: [M.stun] })], enemy: slowEnemy({ mods: { critPct: 0, focusRegen: 0, statusResistPct: 100, healBoostPct: 0, typeBoostPct: 0 } }) });
    const r = must(applyAction(res, createBattle(res), MOVE0));
    expect(r.events).toContainEqual({ k: 'resisted', target: { side: 'enemy' }, status: 'stunned' });
    expect(r.state.enemy.status).toBeNull();
    let landed = 0;
    for (let seed = 0; seed < 200; seed++) {
      const su = setup({ seed, party: [hero({ stats: stats({ spd: 99 }), moves: [M.maybe] })], enemy: slowEnemy() });
      if (must(applyAction(su, createBattle(su), MOVE0)).events.some((e) => e.k === 'status' && e.on && e.status === 'stunned')) landed++;
    }
    expect(landed).toBeGreaterThan(70);
    expect(landed).toBeLessThan(130);
    const stack = setup({ party: [hero({ stats: stats({ spd: 99 }), moves: [M.conflict] })], enemy: slowEnemy() });
    const s = createBattle(stack);
    s.enemy = { ...s.enemy, status: 'burnout', statusTurns: 5 };
    expect(must(applyAction(stack, s, MOVE0)).state.enemy.status).toBe('burnout');
  });
  it('crunch-time style self burnout and buff self effects apply', () => {
    const su = setup({ party: [hero({ stats: stats({ spd: 99 }), moves: [M.crunch, M.buff, M.cureHeal] })], enemy: slowEnemy() });
    expect(must(applyAction(su, createBattle(su), MOVE0)).state.party[0]).toMatchObject({ status: 'burnout' });
    expect(must(applyAction(su, createBattle(su), { t: 'move', move: 1 })).state.party[0]!.buffTurns).toBe(2);
    const s = createBattle(su);
    s.party[0] = { ...s.party[0]!, status: 'burnout', statusTurns: 3 };
    expect(must(applyAction(su, s, { t: 'move', move: 2 })).state.party[0]!.status).toBeNull();
  });
});

describe('enemy ai', () => {
  const ai = (kind: 'aggressive' | 'tricky' | 'tank') => enemy({ ai: kind, stats: stats({ spd: 1, hp: 500 }), moves: [mv('basic'), mv('big', { power: 90, type: 'bug' }), M.stun, mv('guard', { category: 'shield', target: 'self', power: 0, self: { id: 'shielded', turns: 2 } }), mv('mend', { category: 'heal', target: 'self', power: 0, healPct: 25 })] });
  const used = (kind: 'aggressive' | 'tricky' | 'tank', mut?: (s: BattleState) => void) => {
    const counts = new Map<number, number>();
    for (let seed = 0; seed < 400; seed++) {
      const su = setup({ seed, party: [hero({ stats: stats({ spd: 99, hp: 9999 }), moves: [mv('noop', { power: 1 })] })], enemy: ai(kind) });
      const s = createBattle(su);
      mut?.(s);
      for (const e of must(applyAction(su, s, MOVE0)).events) if (e.k === 'use' && e.by.side === 'enemy') counts.set(e.move, (counts.get(e.move) ?? 0) + 1);
    }
    return counts;
  };
  it('aggressive mostly attacks; tank shields more often', () => {
    const a = used('aggressive');
    const attacks = (a.get(0) ?? 0) + (a.get(1) ?? 0);
    expect(attacks).toBeGreaterThan(400 * 0.6);
    expect(attacks).toBeLessThan(400 * 0.8);
    expect((used('tank').get(3) ?? 0)).toBeGreaterThan(a.get(3) ?? 0);
  });
  it('drops useless categories', () => {
    const noStatus = used('tricky', (s) => { s.party[0] = { ...s.party[0]!, status: 'burnout', statusTurns: 3 }; });
    expect(noStatus.get(2) ?? 0).toBe(0);
    const buffedShield = used('tank', (s) => { s.enemy = { ...s.enemy, shieldTurns: 3 }; });
    expect(buffedShield.get(3) ?? 0).toBe(0);
    expect(used('tank').get(4) ?? 0).toBe(0); // full hp: no heal
    const low = used('tank', (s) => { s.enemy = { ...s.enemy, hp: 100 }; });
    expect(low.get(4) ?? 0).toBeGreaterThan(0);
  });
  it('an enemy with only a basic attack always uses it', () => {
    const su = setup({ enemy: quietEnemy() });
    expect(must(applyAction(su, createBattle(su), MOVE0)).events.filter((e) => e.k === 'use' && e.by.side === 'enemy')).toEqual([{ k: 'use', by: { side: 'enemy' }, move: 0 }]);
  });
});

// ------------------------------------------------------------------ determinism, golden, properties

function randomSetup(seed: number): BattleSetup {
  const r = testRng(seed * 7 + 1);
  const mk = (i: number) =>
    hero({
      ref: { kind: 'agent', agentId: `a${i}` }, level: 1 + r(30), type: (['build', 'test', 'review', 'lead'] as const)[r(4)]!,
      stats: stats({ hp: 20 + r(60), atk: 10 + r(40), def: 10 + r(40), spd: 10 + r(40), focus: 20 + r(40) }),
      moves: [M.basic, M.strong, M.multi, M.heal, M.shield, M.buff, M.quick, M.stun, M.conflict, M.burnout, M.crunch, M.cureHeal].slice(0, 1 + r(12)),
      mods: { critPct: r(15), focusRegen: r(3), statusResistPct: r(40), healBoostPct: r(30), typeBoostPct: r(20) },
    });
  const eMoves = [mv('hit', { type: 'bug' }), mv('hard', { power: 70, accuracy: 85 }), M.stun, M.conflict, M.burnout, mv('guard', { category: 'shield', target: 'self', power: 0, self: { id: 'shielded', turns: 2 } }), mv('mend', { category: 'heal', target: 'self', power: 0, healPct: 25 }), M.buff];
  return setup({
    seed: (seed * 2654435761) >>> 0, party: Array.from({ length: 1 + r(4) }, (_, i) => mk(i)), maxTurns: 10 + r(40),
    enemy: enemy({ ai: (['aggressive', 'tricky', 'tank'] as const)[r(3)]!, type: (['bug', 'rival', 'feral', 'bureaucrat'] as const)[r(4)]!, level: 1 + r(30), stats: stats({ hp: 40 + r(150), atk: 10 + r(50), def: 10 + r(40), spd: 10 + r(50) }), moves: eMoves.slice(0, 1 + r(8)) }),
  });
}

describe('determinism and properties', () => {
  it('replay equals the step-by-step fold and a JSON-copied setup; inputs are never mutated', () => {
    let ended = 0;
    for (let seed = 0; seed < 500; seed++) {
      const su = deepFreeze(randomSetup(seed));
      const pick = testRng(seed + 99);
      let st = deepFreeze(createBattle(su));
      const log: PlayerAction[] = [];
      const events: BattleEvent[] = [];
      for (let i = 0; i < 400 && st.phase !== 'ended'; i++) {
        const legal = legalActions(su, st);
        expect(legal.length).toBeGreaterThan(0);
        const a = legal[pick(legal.length)]!;
        const prev = st;
        const r = must(applyAction(su, prev, a));
        expect(JSON.stringify(prev)).toBe(JSON.stringify(st));
        // properties
        const nx = r.state;
        nx.party.forEach((p, k) => {
          expect(p.hp).toBeGreaterThanOrEqual(0);
          expect(p.hp).toBeLessThanOrEqual(su.party[k]!.stats.hp);
          expect(p.focus).toBeGreaterThanOrEqual(0);
          expect(p.focus).toBeLessThanOrEqual(su.party[k]!.stats.focus);
          expect(p.fainted).toBe(p.hp === 0);
          if (prev.party[k]!.fainted) expect(p.hp).toBe(0);
        });
        expect(nx.enemy.hp).toBeGreaterThanOrEqual(0);
        expect(nx.enemy.hp).toBeLessThanOrEqual(su.enemy.stats.hp);
        expect(nx.items.every((n) => n >= 0)).toBe(true);
        expect(nx.phase === 'ended').toBe(nx.result !== null);
        expect(nx.actions).toBe(prev.actions + 1);
        for (const e of r.events) {
          if (e.k === 'use' && e.by.side === 'party') expect(e.by.index).toBe(prev.active);
          if (e.k === 'damage') {
            expect(e.amount).toBeGreaterThanOrEqual(1);
            if (e.target.side === 'party') expect(prev.party[e.target.index]!.fainted).toBe(false);
          }
          if (e.k === 'heal' && e.target.side === 'party') expect(prev.party[e.target.index]!.fainted).toBe(false);
        }
        st = deepFreeze(nx);
        log.push(a);
        events.push(...r.events);
      }
      expect(st.phase).toBe('ended');
      expect(st.turn - 1).toBeLessThanOrEqual(su.maxTurns);
      expect(log.length).toBeLessThanOrEqual(su.maxTurns + su.party.length);
      if (st.result === 'won' || st.result === 'lost') ended++;
      const rep = replay(su, log);
      expect(rep).toEqual({ ok: true, state: st, events, result: st.result, turns: st.turn - 1 });
      expect(replay(JSON.parse(JSON.stringify(su)) as BattleSetup, log)).toEqual(rep);
    }
    expect(ended).toBeGreaterThan(100);
  });
  it('a hero type chart check: super-effective is never below neutral on the preview', () => {
    for (const [atk, def] of [['test', 'bug'], ['build', 'bureaucrat'], ['lead', 'feral'], ['review', 'rival']] as const) {
      const su = setup({ party: [hero({ type: atk, moves: [mv('m', { type: atk, power: 50 })] })], enemy: quietEnemy({ type: def }) });
      const sup = damagePreview(su, createBattle(su), 0)!;
      const neu = damagePreview(setup({ party: su.party, enemy: quietEnemy({ type: 'salesy' }) }), createBattle(su), 0)!;
      expect(sup.eff).toBe('super');
      expect(sup.min).toBeGreaterThanOrEqual(neu.min);
    }
  });
  it('matches the golden event list for a fixed setup and log (changes only with ENGINE_VERSION)', () => {
    expect(ENGINE_VERSION).toBe(1);
    const log: PlayerAction[] = [{ t: 'move', move: 1 }, MOVE0, { t: 'item', item: 0 }, { t: 'move', move: 3 }, { t: 'swap', to: 1 }, { t: 'move', move: 5 }, MOVE0];
    const r = replay(setup(), log);
    expect(r.ok).toBe(true);
    expect(r.ok && { result: r.result, turns: r.turns, rng: r.state.rng, events: r.events.map((e) => JSON.stringify(e)) }).toMatchInlineSnapshot(`
      {
        "events": [
          "{"k":"start"}",
          "{"k":"turn","turn":1}",
          "{"k":"use","by":{"side":"party","index":0},"move":1}",
          "{"k":"focus","target":{"side":"party","index":0},"amount":-8,"focus":32}",
          "{"k":"damage","target":{"side":"enemy"},"amount":6,"hp":84,"eff":"weak","crit":false,"selfHit":false}",
          "{"k":"use","by":{"side":"enemy"},"move":1}",
          "{"k":"status","target":{"side":"party","index":0},"status":"stunned","on":true}",
          "{"k":"focus","target":{"side":"party","index":0},"amount":2,"focus":34}",
          "{"k":"turn","turn":2}",
          "{"k":"skip","by":{"side":"party","index":0},"reason":"stunned"}",
          "{"k":"status","target":{"side":"party","index":0},"status":"stunned","on":false}",
          "{"k":"use","by":{"side":"enemy"},"move":0}",
          "{"k":"damage","target":{"side":"party","index":0},"amount":22,"hp":38,"eff":"super","crit":false,"selfHit":false}",
          "{"k":"focus","target":{"side":"party","index":0},"amount":2,"focus":36}",
          "{"k":"turn","turn":3}",
          "{"k":"item","item":0,"target":0}",
          "{"k":"heal","target":{"side":"party","index":0},"amount":22,"hp":60}",
          "{"k":"use","by":{"side":"enemy"},"move":0}",
          "{"k":"damage","target":{"side":"party","index":0},"amount":18,"hp":42,"eff":"super","crit":false,"selfHit":false}",
          "{"k":"focus","target":{"side":"party","index":0},"amount":2,"focus":38}",
          "{"k":"turn","turn":4}",
          "{"k":"use","by":{"side":"party","index":0},"move":3}",
          "{"k":"focus","target":{"side":"party","index":0},"amount":-8,"focus":30}",
          "{"k":"status","target":{"side":"party","index":0},"status":"shielded","on":true}",
          "{"k":"use","by":{"side":"enemy"},"move":0}",
          "{"k":"damage","target":{"side":"party","index":0},"amount":9,"hp":33,"eff":"super","crit":false,"selfHit":false}",
          "{"k":"focus","target":{"side":"party","index":0},"amount":2,"focus":32}",
          "{"k":"turn","turn":5}",
          "{"k":"status","target":{"side":"party","index":0},"status":"shielded","on":false}",
          "{"k":"swap","from":0,"to":1,"forced":false}",
          "{"k":"use","by":{"side":"enemy"},"move":0}",
          "{"k":"damage","target":{"side":"party","index":1},"amount":20,"hp":40,"eff":"super","crit":false,"selfHit":false}",
          "{"k":"turn","turn":6}",
          "{"k":"use","by":{"side":"party","index":1},"move":5}",
          "{"k":"focus","target":{"side":"party","index":1},"amount":-6,"focus":34}",
          "{"k":"damage","target":{"side":"enemy"},"amount":5,"hp":79,"eff":"weak","crit":false,"selfHit":false}",
          "{"k":"use","by":{"side":"enemy"},"move":0}",
          "{"k":"damage","target":{"side":"party","index":1},"amount":32,"hp":8,"eff":"super","crit":true,"selfHit":false}",
          "{"k":"focus","target":{"side":"party","index":1},"amount":2,"focus":36}",
          "{"k":"turn","turn":7}",
          "{"k":"use","by":{"side":"party","index":1},"move":0}",
          "{"k":"damage","target":{"side":"enemy"},"amount":4,"hp":75,"eff":"weak","crit":false,"selfHit":false}",
          "{"k":"use","by":{"side":"enemy"},"move":0}",
          "{"k":"damage","target":{"side":"party","index":1},"amount":20,"hp":0,"eff":"super","crit":false,"selfHit":false}",
          "{"k":"faint","target":{"side":"party","index":1}}",
        ],
        "result": null,
        "rng": 2334717439,
        "turns": 7,
      }
    `);
  });
  it('legalActions is empty once ended and only lists affordable moves and owned items', () => {
    const su = setup();
    const s = createBattle(su);
    s.party[0] = { ...s.party[0]!, focus: 5 };
    s.items = [0, 1, 0, 0];
    const acts = legalActions(su, s);
    expect(acts).not.toContainEqual({ t: 'move', move: 1 });
    expect(acts).toContainEqual({ t: 'move', move: 0 });
    expect(acts.filter((a) => a.t === 'item')).toEqual([{ t: 'item', item: 1 }, { t: 'item', item: 1, target: 1 }]);
    expect(acts.every((a) => err(su, s, a) === null)).toBe(true);
    expect(legalActions(su, { ...s, phase: 'ended', result: 'won' })).toEqual([]);
  });
  it('coffee is a heal item through the public setup shape', () => {
    expect(COFFEE.effect).toBe('heal');
    expect(rngNext(1).value).toBeGreaterThanOrEqual(0);
  });
});

describe('purity', () => {
  it('battle/*.ts uses no ambient randomness, clock or pow', () => {
    const dir = fileURLToPath(new URL('..', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files).toContain('engine.ts');
    for (const f of files) {
      const src = readFileSync(`${dir}${f}`, 'utf8');
      for (const bad of ['Math.random', 'Math.pow', 'Date', 'performance']) {
        expect(src.includes(bad), `${f} contains ${bad}`).toBe(false);
      }
    }
  });
});
