import { describe, expect, it } from 'vitest';
import {
  CLASS_BASE, CLASS_IDS, ENEMIES, ENGINE_VERSION, PROGRESSION_LIMITS, SKILL_TREES, battleXp, buildBattleSetup, classForRole, combatModsFor, computeOutcome,
  emptyCore, enemyHpPct, enemyLevelFor, movesFor, progressView, skillsForClass, statsFor, xpForLevel,
  type BattleResult, type BattleSetup, type BattleState, type HeroProgressCore, type LevelCurve, type OutcomeConfig, type PartyMemberInput,
} from '../../index.js';

const curve: LevelCurve = { levelBase: 1500, levelExponent: 2, maxLevel: 50 };
const items = { coffee: 2, energyDrink: 1, rubberDuck: 1, pizza: 0 };
const member = (n: string, level: number, over: Partial<PartyMemberInput> = {}): PartyMemberInput => ({
  ref: { kind: 'hero', heroId: `h-${n}` }, name: n, role: 'developer', xp: xpForLevel(level, curve), skills: {}, temporary: false, ...over,
});
const build = (party: PartyMemberInput[], seed = 1, npcKind: keyof typeof ENEMIES = 'guest', difficulty = 1): BattleSetup =>
  buildBattleSetup({ seed, npcKind, party, curve, difficulty, items, maxTurns: 60 });

describe('statsFor', () => {
  it('matches the section 4.2 developer table', () => {
    expect(statsFor('developer', 1, {})).toEqual({ hp: 12, atk: 6, def: 6, spd: 5 + 1, focus: 11 });
    const l10 = statsFor('developer', 10, {});
    expect([l10.hp, l10.atk, l10.def, l10.focus]).toEqual([32, 20, 16, 20]);
    const l30 = statsFor('developer', 30, {});
    expect([l30.hp, l30.atk, l30.def, l30.focus]).toEqual([76, 50, 38, 40]);
    const l50 = statsFor('developer', 50, {});
    expect([l50.hp, l50.atk, l50.def, l50.focus]).toEqual([120, 80, 60, 60]);
  });
  it('applies stat passives per rank (lead gets HP in the defense branch)', () => {
    const base = statsFor('developer', 30, {});
    expect(statsFor('developer', 30, { 'developer.0.1': 5 }).atk).toBe(Math.floor((base.atk * 120) / 100));
    expect(statsFor('developer', 30, { 'developer.0.1': 99 }).atk).toBe(Math.floor((base.atk * 120) / 100)); // clamped to maxRank
    const lead = statsFor('lead', 30, {});
    expect(statsFor('lead', 30, { 'lead.1.1': 2 }).hp).toBe(Math.floor((lead.hp * 108) / 100));
    expect(statsFor('lead', 30, { 'lead.1.1': 2 }).def).toBe(lead.def);
  });
  it('is defined for every class', () => {
    for (const c of CLASS_IDS) expect(statsFor(c, 20, {}).hp).toBeGreaterThan(CLASS_BASE[c].hp / 10);
  });
});

describe('mods, moves, skillsForClass', () => {
  it('combatModsFor sums passives', () => {
    expect(combatModsFor('developer', { 'developer.0.3': 3, 'developer.2.3': 2, 'developer.1.3': 1 })).toEqual({ critPct: 6, focusRegen: 2, statusResistPct: 8, healBoostPct: 0, typeBoostPct: 0 });
    expect(combatModsFor('qa', { 'qa.0.3': 2 }).healBoostPct).toBe(20);
    expect(combatModsFor('analyst', { 'analyst.2.3': 2 }).typeBoostPct).toBe(10);
  });
  it('movesFor: basic first, unlocked moves in tree order, <= 8', () => {
    expect(movesFor('developer', {}).map((m) => m.id)).toEqual(['commit']);
    expect(movesFor('developer', { 'developer.2.2': 1, 'developer.0.2': 1 }).map((m) => m.id)).toEqual(['commit', 'hotfix', 'quick-deploy']);
    const all = Object.fromEntries(SKILL_TREES.lead.nodes.map((n) => [n.id, 1]));
    expect(movesFor('lead', all)).toHaveLength(7);
  });
  it('ignore __proto__/constructor keys and foreign classes; null-prototype output', () => {
    const evil = JSON.parse('{"__proto__": 5, "constructor": 3, "toString": 2, "qa.0.1": 3, "developer.0.1": 2}') as Record<string, number>;
    const s = skillsForClass('developer', evil);
    expect(Object.getPrototypeOf(s)).toBeNull();
    expect(Object.keys(s)).toEqual(['developer.0.1']);
    expect(combatModsFor('developer', evil)).toEqual({ critPct: 0, focusRegen: 0, statusResistPct: 0, healBoostPct: 0, typeBoostPct: 0 });
    expect(movesFor('developer', evil)).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('enemy scaling', () => {
  it('enemyHpPct', () => {
    expect([1, 2, 3, 4].map(enemyHpPct)).toEqual([130, 145, 160, 175]);
  });
  it('enemyLevelFor stays within spread and clamps', () => {
    for (let seed = 0; seed < 400; seed++) {
      const l = enemyLevelFor(10, 1, seed, 50);
      expect(l).toBeGreaterThanOrEqual(9);
      expect(l).toBeLessThanOrEqual(12);
      expect(enemyLevelFor(1, 0.5, seed, 50)).toBeGreaterThanOrEqual(1);
      expect(enemyLevelFor(50, 2, seed, 50)).toBeLessThanOrEqual(55);
    }
    expect(new Set(Array.from({ length: 200 }, (_, s) => enemyLevelFor(10, 1, s, 50))).size).toBe(4);
  });
});

describe('buildBattleSetup', () => {
  it('is deterministic per seed and JSON-stable', () => {
    const p = [member('a', 10), member('b', 12)];
    expect(build(p, 7)).toEqual(build(p, 7));
    const s = build(p, 7);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(s.engineVersion).toBe(ENGINE_VERSION);
    expect(s.party).toHaveLength(2);
    expect(s.items.map((i) => [i.def.id, i.count])).toEqual([['coffee', 2], ['energy-drink', 1], ['rubber-duck', 1]]);
  });
  it('builds hero and enemy combatants', () => {
    const s = build([member('Brom', 10, { skills: { 'developer.0.2': 1, 'qa.0.1': 4 } })], 3, 'monster');
    const h = s.party[0]!;
    expect(h).toMatchObject({ name: 'Brom', classId: 'developer', type: 'build', level: 10, temporary: false, ai: null });
    expect(h.moves.map((m) => m.id)).toEqual(['commit', 'hotfix']);
    expect(s.enemy).toMatchObject({ classId: null, type: 'bug', ai: 'aggressive', ref: { kind: 'enemy', npcKind: 'monster' }, temporary: false });
    expect(s.enemy.moves.map((m) => m.id)).toEqual([...ENEMIES.monster.moves]);
  });
  it('enemy HP scales with party size', () => {
    const one = build([member('a', 10)], 5);
    const four = build([member('a', 10), member('b', 10), member('c', 10), member('d', 10)], 5);
    expect(one.enemy.level).toBe(four.enemy.level);
    expect(four.enemy.stats.hp).toBeGreaterThan(one.enemy.stats.hp);
    expect(four.enemy.stats.hp).toBe(Math.floor((one.enemy.stats.hp / 130) * 175));
  });
  it('sanitizes names, caps the party and rejects an empty one', () => {
    expect(build([member('x\u0007y\n' + 'z'.repeat(60), 3)]).party[0]!.name).toHaveLength(40);
    expect(build([member('   ', 3)]).party[0]!.name).toBe('Hero');
    expect(build(Array.from({ length: 6 }, (_, k) => member(`m${k}`, 2))).party).toHaveLength(PROGRESSION_LIMITS.maxParty);
    expect(() => build([])).toThrow();
  });
  it('F13: a temporary member counts at most at the highest hero level', () => {
    const base = build([member('hero', 5)], 11);
    const withAnon = build([member('hero', 5), member('anon', 40, { temporary: true, ref: { kind: 'agent', agentId: 'ag' } })], 11);
    const allHeroes = build([member('hero', 5), member('big', 40)], 11);
    expect(withAnon.party[1]!.level).toBe(40); // its own combat level is unchanged
    expect(withAnon.enemy.level).toBe(base.enemy.level); // avg = (5 + 5) / 2
    expect(allHeroes.enemy.level).toBeGreaterThan(withAnon.enemy.level);
  });
  it('F13: an anonymous-only party uses its own level', () => {
    const s = build([member('anon', 20, { temporary: true, ref: { kind: 'agent', agentId: 'ag' } })], 11);
    expect(Math.abs(s.enemy.level - 20)).toBeLessThanOrEqual(2);
  });
});

describe('battleXp', () => {
  it('round(levelBase * L * xpScale), half when fainted', () => {
    expect(battleXp(10, 1500, 0.5, false)).toBe(7500);
    expect(battleXp(10, 1500, 0.5, true)).toBe(3750);
    expect(battleXp(7, 1501, 0.5, false)).toBe(Math.round(1501 * 7 * 0.5));
    expect(battleXp(10, 1500, 0, false)).toBe(0);
  });
});

const cfg: OutcomeConfig = { curve, skillPointsPerLevel: 1, xpScale: 0.5, koMinutes: 5, skillPointEveryWins: 3, lootChance: 1 };
const NOW = 1_000_000;
function fixture(npc: keyof typeof ENEMIES = 'guest', n = 2, level = 10): { setup: BattleSetup; final: BattleState; cores: { heroId: string; memberIndex: number; core: HeroProgressCore }[] } {
  const setup = build(Array.from({ length: n }, (_, k) => member(`m${k}`, level)), 9, npc);
  const cores = setup.party.map((_, k) => ({ heroId: `h-m${k}`, memberIndex: k, core: { ...emptyCore('developer', 0), xp: xpForLevel(level, curve) } }));
  const final: BattleState = {
    engineVersion: ENGINE_VERSION, rng: 0, turn: 5, phase: 'ended', active: 0, enemy: { hp: 0, focus: 0, status: null, statusTurns: 0, buffTurns: 0, shieldTurns: 0, fainted: true },
    party: setup.party.map(() => ({ hp: 10, focus: 5, status: null, statusTurns: 0, buffTurns: 0, shieldTurns: 0, fainted: false })), items: [], runAttempts: 0, actions: 4, result: 'won',
  };
  return { setup, final, cores };
}
const run = (f: ReturnType<typeof fixture>, result: BattleResult, over: Partial<OutcomeConfig> = {}, lootSeed = 1, heroes = f.cores) =>
  computeOutcome({ setup: f.setup, final: f.final, result, turns: 4, lootSeed, heroes, cfg: { ...cfg, ...over }, now: NOW });

describe('computeOutcome', () => {
  it('won: XP, wins, no KO for the living, half XP and KO for the fainted', () => {
    const f = fixture();
    f.final.party[1]!.fainted = true;
    const o = run(f, 'won');
    const full = battleXp(f.setup.enemy.level, 1500, 0.5, false);
    expect(o.awards[0]).toMatchObject({ heroId: 'h-m0', xpGained: full, fainted: false, koUntil: null });
    expect(o.awards[1]).toMatchObject({ xpGained: Math.floor(full / 2), fainted: true, koUntil: NOW + 300_000 });
    expect(o.next['h-m0']).toMatchObject({ wins: 1, losses: 0, flees: 0, updatedAt: NOW, xp: xpForLevel(10, curve) + full });
    expect(o.next['h-m1']?.koUntil).toBe(NOW + 300_000);
    expect(o.awards[0]!.levelAfter).toBeGreaterThanOrEqual(o.awards[0]!.levelBefore);
  });
  it('level-up awards points per level; a bonus point every N wins', () => {
    const f = fixture('guest', 1, 10);
    f.cores[0]!.core = { ...f.cores[0]!.core, xp: xpForLevel(11, curve) - 1, wins: 2 };
    const o = run(f, 'won');
    expect(o.awards[0]!.levelAfter).toBeGreaterThan(o.awards[0]!.levelBefore);
    expect(o.awards[0]!.skillPointsGained).toBe((o.awards[0]!.levelAfter - o.awards[0]!.levelBefore) * 1 + 1);
    expect(o.next['h-m0']).toMatchObject({ wins: 3, bonusPoints: 1 });
    expect(run(fixture(), 'won', { skillPointEveryWins: 0 }).next['h-m0']!.bonusPoints).toBe(0);
  });
  it('caps XP at heroLevel + 5 per hero', () => {
    const f = fixture('guest', 2, 10);
    f.cores[0]!.core = { ...f.cores[0]!.core, xp: xpForLevel(2, curve) }; // a level 2 hero next to a high enemy
    const o = run(f, 'won');
    expect(f.setup.enemy.level).toBeGreaterThan(7);
    expect(o.awards[0]!.xpGained).toBe(battleXp(7, 1500, 0.5, false));
    expect(o.awards[1]!.xpGained).toBe(battleXp(f.setup.enemy.level, 1500, 0.5, false));
  });
  it('clamps XP per update and total', () => {
    const f = fixture();
    const o1 = run(f, 'won', { xpScale: 10, curve: { ...curve, levelBase: 10_000_000 } });
    expect(o1.awards[0]!.xpGained).toBeLessThanOrEqual(PROGRESSION_LIMITS.maxXpPerUpdate);
    const f2 = fixture();
    f2.cores[0]!.core = { ...f2.cores[0]!.core, xp: PROGRESSION_LIMITS.maxXp - 10 };
    const o2 = run(f2, 'won');
    expect(o2.next['h-m0']!.xp).toBe(PROGRESSION_LIMITS.maxXp);
    expect(o2.awards[0]!.xpGained).toBe(10);
  });
  it('lost: no XP, losses++, KO for all; fled/timeout: flees++, KO for the fainted', () => {
    const f = fixture();
    const lost = run(f, 'lost');
    expect(lost.awards.map((a) => a.xpGained)).toEqual([0, 0]);
    expect(lost.next['h-m0']).toMatchObject({ losses: 1, wins: 0, koUntil: NOW + 300_000 });
    expect(lost.loot).toBeNull();
    f.final.party[1]!.fainted = true;
    for (const r of ['fled', 'timeout'] as const) {
      const o = run(f, r);
      expect(o.next['h-m0']).toMatchObject({ flees: 1, koUntil: null });
      expect(o.next['h-m1']).toMatchObject({ flees: 1, koUntil: NOW + 300_000 });
      expect(o.loot).toBeNull();
    }
    expect(run(f, 'lost', { koMinutes: 0 }).next['h-m0']!.koUntil).toBeNull();
  });
  it('does not mutate inputs; returns null-prototype records', () => {
    const f = fixture();
    const before = JSON.stringify(f.cores);
    const o = run(f, 'won');
    expect(JSON.stringify(f.cores)).toBe(before);
    expect(Object.getPrototypeOf(o.next)).toBeNull();
    expect(Object.getPrototypeOf(o.next['h-m0'])).toBeNull();
    expect(Object.getPrototypeOf(o.next['h-m0']!.skills)).toBeNull();
  });
  it('loot is driven by lootSeed only', () => {
    const f = fixture('monster', 2);
    const a = run(f, 'won', {}, 123);
    expect(run(f, 'won', {}, 123)).toEqual(a);
    const seen = new Set<string>();
    const recipients = new Set<string>();
    for (let s = 0; s < 300; s++) {
      const o = run(f, 'won', {}, s);
      expect(o.loot).not.toBeNull();
      seen.add(o.loot!.lootId);
      recipients.add(o.loot!.heroId);
      expect(ENEMIES.monster.loot.some((l) => l.id === o.loot!.lootId)).toBe(true);
      expect(o.next[o.loot!.heroId]!.loot).toEqual([o.loot!.lootId]);
    }
    expect(seen.size).toBe(3);
    expect(recipients.size).toBe(2);
  });
  it('loot chance 0 never drops; owned loot is skipped; none left = no loot; fainted heroes only if everyone fainted', () => {
    const f = fixture('office-cat', 2);
    for (let s = 0; s < 50; s++) expect(run(f, 'won', { lootChance: 0 }, s).loot).toBeNull();
    f.cores[0]!.core = { ...f.cores[0]!.core, loot: ['title-cat-whisperer'] };
    f.cores[1]!.core = { ...f.cores[1]!.core, loot: ['title-cat-whisperer', 'prop-parcel'] };
    for (let s = 0; s < 50; s++) {
      const o = run(f, 'won', {}, s);
      if (o.loot) { expect(o.loot).toEqual({ heroId: 'h-m0', lootId: 'prop-parcel' }); }
    }
    f.final.party[0]!.fainted = true;
    for (let s = 0; s < 50; s++) expect(run(f, 'won', {}, s).loot).toBeNull(); // only living hero m1 is eligible and owns everything
    f.final.party[1]!.fainted = true;
    expect(Array.from({ length: 50 }, (_, s) => run(f, 'won', {}, s).loot?.heroId).filter(Boolean).every((h) => h === 'h-m0')).toBe(true);
  });
  it('anonymous members are simply not in `heroes` (no award)', () => {
    const f = fixture();
    const o = run(f, 'won', {}, 1, [f.cores[0]!]);
    expect(o.awards).toHaveLength(1);
    expect(Object.keys(o.next)).toEqual(['h-m0']);
  });
});

describe('emptyCore / progressView', () => {
  it('emptyCore', () => {
    const c = emptyCore('qa-engineer', 5);
    expect(c).toMatchObject({ classId: 'qa', xp: 0, bonusPoints: 0, koUntil: null, wins: 0, loot: [], equippedTitle: null, updatedAt: 5 });
    expect(Object.getPrototypeOf(c.skills)).toBeNull();
    expect(emptyCore('weird-role', 0).classId).toBe('adventurer');
  });
  const pcfg = { curve, skillPointsPerLevel: 1 };
  it('derives level, points and the XP span', () => {
    const core: HeroProgressCore = { ...emptyCore('developer', 1), xp: xpForLevel(5, curve) + 10, bonusPoints: 2, skills: { 'developer.0.1': 3 } };
    const v = progressView('h-a', 'proj', 'developer', core, pcfg);
    expect(v).toMatchObject({ heroId: 'h-a', projectId: 'proj', classId: 'developer', level: 5, levelXp: xpForLevel(5, curve), nextLevelXp: xpForLevel(6, curve), skillPoints: 4 + 2 - 3, overspent: false });
    expect(v.skills).toEqual({ 'developer.0.1': 3 });
  });
  it('refunds everything on a class change', () => {
    const core: HeroProgressCore = { ...emptyCore('developer', 1), xp: xpForLevel(5, curve), skills: { 'developer.0.1': 3 } };
    const v = progressView('h-a', 'p', 'qa-engineer', core, pcfg);
    expect(v.classId).toBe('qa');
    expect(v.skills).toEqual({});
    expect(v.skillPoints).toBe(4);
    expect(v.overspent).toBe(false);
  });
  it('flags overspent after a curve change and keeps the skills', () => {
    const core: HeroProgressCore = { ...emptyCore('developer', 1), xp: xpForLevel(3, curve), skills: { 'developer.0.1': 5, 'developer.0.2': 1 } };
    const v = progressView('h-a', 'p', 'developer', core, pcfg);
    expect(v.overspent).toBe(true);
    expect(v.skillPoints).toBe(0);
    expect(Object.keys(v.skills)).toHaveLength(2);
  });
  it('drops __proto__ keys and passes the zod view', async () => {
    const { HeroProgressSchema } = await import('../../progression.js');
    const core: HeroProgressCore = { ...emptyCore('developer', 1), skills: JSON.parse('{"__proto__": 2, "developer.0.1": 1}') as Record<string, number> };
    const v = progressView('h-0123abcd', 'p', 'developer', core, pcfg);
    expect(Object.keys(v.skills)).toEqual(['developer.0.1']);
    expect(HeroProgressSchema.safeParse(v).success).toBe(true);
    expect(classForRole('developer')).toBe('developer');
  });
});
