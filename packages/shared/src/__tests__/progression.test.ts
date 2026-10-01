import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BattleCreateSchema,
  BattleResolveSchema,
  CLASS_IDS,
  EmptyBodySchema,
  HeroAppearanceSchema,
  HeroProgressSchema,
  LOOT_HATS,
  LOOT_IDS,
  LOOT_PROPS,
  PartyRefSchema,
  PlayerActionSchema,
  ProgressListQuerySchema,
  SkillAllocationSchema,
  TitleEquipSchema,
  advanceUsageMark,
  classForRole,
  levelForXp,
  levelSpan,
  lootGrant,
  skillPointsSpent,
  skillPointsTotal,
  validateSkillAllocation,
  xpForLevel,
  xpFromUsage,
  PROGRESSION_LIMITS,
  SettingsSchema,
  type LevelCurve,
  type SkillId,
  type SkillTree,
  type UsageCounters,
  type XpWeights,
} from '../index.js';

const W: XpWeights = { output: 1, input: 0.5, cacheCreation: 0.25, cacheRead: 0 };
const U = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheCreationTokens = 0): UsageCounters => ({
  inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
});

describe('classForRole', () => {
  it('maps every shipped role', () => {
    const dir = fileURLToPath(new URL('../../../agent-templates/roles', import.meta.url));
    const roles = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
    expect(roles.length).toBeGreaterThan(5);
    for (const r of roles) {
      expect(CLASS_IDS).toContain(classForRole(r));
      expect(classForRole(r)).not.toBe('adventurer');
    }
    expect(classForRole('pm')).toBe('lead');
    expect(classForRole('code-reviewer')).toBe('reviewer');
    expect(classForRole('devops-engineer')).toBe('developer');
  });
  it('unknown and reserved keys fall back to adventurer', () => {
    for (const r of ['', 'nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) expect(classForRole(r)).toBe('adventurer');
  });
});

describe('xpFromUsage', () => {
  it('weights and floors', () => {
    expect(xpFromUsage(U(10, 10, 1000, 4), W)).toBe(10 + 5 + 1); // 16
    expect(xpFromUsage(U(1, 0), W)).toBe(0);
    expect(xpFromUsage(U(3, 0), W)).toBe(1);
  });
  it('negative / NaN / Infinity count as 0', () => {
    expect(xpFromUsage(U(-5, NaN, Infinity, -1), W)).toBe(0);
    expect(xpFromUsage(U(0, 7), W)).toBe(7);
  });
});

describe('levels', () => {
  for (const levelExponent of [1, 1.5, 2, 4]) {
    it(`exact boundaries at exponent ${levelExponent}`, () => {
      const c: LevelCurve = { levelBase: 100, levelExponent, maxLevel: 100 };
      expect(xpForLevel(1, c)).toBe(0);
      expect(levelForXp(0, c)).toBe(1);
      for (let L = 2; L <= 100; L++) {
        const x = xpForLevel(L, c);
        expect(levelForXp(x, c)).toBe(L);
        expect(levelForXp(x - 1, c)).toBe(L - 1);
      }
      expect(levelForXp(1e15, c)).toBe(100);
    });
  }
  it('caps at maxLevel and span ends there', () => {
    const c: LevelCurve = { levelBase: 100, levelExponent: 1.5, maxLevel: 10 };
    expect(levelForXp(1e12, c)).toBe(10);
    expect(levelSpan(1e12, c)).toEqual({ level: 10, levelXp: xpForLevel(10, c), nextLevelXp: null });
    expect(levelSpan(0, c)).toEqual({ level: 1, levelXp: 0, nextLevelXp: 100 });
    expect(levelForXp(NaN, c)).toBe(1);
    expect(levelForXp(-5, c)).toBe(1);
  });
});

describe('advanceUsageMark', () => {
  it('re-parse yields no delta, smaller usage neither', () => {
    const a = advanceUsageMark(null, U(10, 100, 5, 8), W);
    expect(a.changed).toBe(true);
    const b = advanceUsageMark(a.mark, U(10, 100, 5, 8), W);
    expect(b).toMatchObject({ changed: false, xpDelta: 0, mark: a.mark });
    const c = advanceUsageMark(a.mark, U(1, 2, 0, 0), W);
    expect(c).toMatchObject({ changed: false, xpDelta: 0, mark: a.mark });
  });
  it('is component-wise (a drop in one counter does not hide a rise in another)', () => {
    const a = advanceUsageMark(null, U(10, 100), W);
    const b = advanceUsageMark(a.mark, U(0, 150), W);
    expect(b.mark).toEqual(U(10, 150));
    expect(b.xpDelta).toBe(50);
  });
  it('telescoping sums equal one big delta, fractional weights lose nothing', () => {
    const w: XpWeights = { output: 1, input: 0.3, cacheCreation: 0.7, cacheRead: 0.1 };
    let prev: UsageCounters | null = null;
    let sum = 0;
    for (let i = 1; i <= 37; i++) {
      const r = advanceUsageMark(prev, U(i * 3, i * 7, i * 11, i * 5), w);
      sum += r.xpDelta;
      prev = r.mark;
    }
    expect(sum).toBe(xpFromUsage(U(37 * 3, 37 * 7, 37 * 11, 37 * 5), w));
  });
});

// A small hand-built tree: branch 0 chain of 2, level gate on node 2.
const node = (branch: 0 | 1 | 2, tier: 1 | 2 | 3 | 4, extra: Partial<SkillTree['nodes'][number]> = {}) =>
  ({
    id: `developer.${branch}.${tier}` as SkillId, classId: 'developer', branch, tier, maxRank: 3, minLevel: 1, requires: [],
    effect: { kind: 'crit', pctPerRank: 1 }, ...extra,
  }) as SkillTree['nodes'][number];
const TREE: SkillTree = {
  classId: 'developer',
  nodes: [node(0, 1), node(0, 2, { minLevel: 5, requires: [{ id: 'developer.0.1', rank: 2 }] }), node(1, 1)],
};
const ctx = (o: Partial<{ level: number; totalPoints: number; allowRespec: boolean }> = {}) => ({ level: 10, totalPoints: 10, allowRespec: true, ...o });

describe('validateSkillAllocation', () => {
  it('ok', () => {
    expect(validateSkillAllocation(TREE, { 'developer.0.1': 2, 'developer.0.2': 1 }, {}, ctx())).toEqual({ ok: true });
    expect(validateSkillAllocation(TREE, {}, {}, ctx())).toEqual({ ok: true });
  });
  it('unknown-skill', () => {
    expect(validateSkillAllocation(TREE, { 'developer.2.4': 1 }, {}, ctx())).toMatchObject({ ok: false, code: 'unknown-skill', skillId: 'developer.2.4' });
    expect(validateSkillAllocation(TREE, { 'qa.0.1': 1 }, {}, ctx())).toMatchObject({ code: 'unknown-skill' });
  });
  it('rank-out-of-range', () => {
    for (const r of [0, 4, -1, 1.5]) expect(validateSkillAllocation(TREE, { 'developer.0.1': r }, {}, ctx())).toMatchObject({ code: 'rank-out-of-range' });
  });
  it('level-too-low', () => {
    expect(validateSkillAllocation(TREE, { 'developer.0.1': 2, 'developer.0.2': 1 }, {}, ctx({ level: 4 }))).toMatchObject({ code: 'level-too-low', skillId: 'developer.0.2' });
  });
  it('missing-prerequisite', () => {
    expect(validateSkillAllocation(TREE, { 'developer.0.1': 1, 'developer.0.2': 1 }, {}, ctx())).toMatchObject({ code: 'missing-prerequisite', skillId: 'developer.0.2' });
    expect(validateSkillAllocation(TREE, { 'developer.0.2': 1 }, {}, ctx())).toMatchObject({ code: 'missing-prerequisite' });
  });
  it('not-enough-points', () => {
    expect(validateSkillAllocation(TREE, { 'developer.0.1': 3, 'developer.1.1': 3 }, {}, ctx({ totalPoints: 5 }))).toMatchObject({ code: 'not-enough-points' });
    expect(validateSkillAllocation(TREE, { 'developer.0.1': 3, 'developer.1.1': 2 }, {}, ctx({ totalPoints: 5 }))).toEqual({ ok: true });
  });
  it('respec-disabled, but growth is fine and invalid/overspent current may shrink', () => {
    const cur = { 'developer.0.1': 2 };
    expect(validateSkillAllocation(TREE, { 'developer.0.1': 1 }, cur, ctx({ allowRespec: false }))).toMatchObject({ code: 'respec-disabled' });
    expect(validateSkillAllocation(TREE, {}, cur, ctx({ allowRespec: false }))).toMatchObject({ code: 'respec-disabled' });
    expect(validateSkillAllocation(TREE, { 'developer.0.1': 3 }, cur, ctx({ allowRespec: false }))).toEqual({ ok: true });
    expect(validateSkillAllocation(TREE, { 'developer.0.1': 1 }, cur, ctx({ allowRespec: false, totalPoints: 1 }))).toEqual({ ok: true });
    expect(validateSkillAllocation(TREE, {}, { 'qa.0.1': 1 }, ctx({ allowRespec: false }))).toEqual({ ok: true });
  });
  it('ignores prototype keys on next/current safely', () => {
    const evil = JSON.parse('{"__proto__": 1}') as Record<string, number>;
    expect(validateSkillAllocation(TREE, evil, {}, ctx())).toMatchObject({ code: 'unknown-skill' });
    expect(validateSkillAllocation(TREE, { 'developer.0.1': 1 }, {}, ctx())).toEqual({ ok: true });
  });
  it('point helpers', () => {
    expect(skillPointsSpent({ a: 2, b: 3 })).toBe(5);
    expect(skillPointsTotal(1, 2, 0)).toBe(0);
    expect(skillPointsTotal(10, 2, 3)).toBe(21);
  });
});

describe('lootGrant', () => {
  it('is total over LOOT_IDS and hats/props are in the vocabulary', () => {
    for (const id of LOOT_IDS) {
      const g = lootGrant(id);
      if (g.kind === 'hat') expect(LOOT_HATS).toContain(g.hat);
      if (g.kind === 'prop') expect(LOOT_PROPS).toContain(g.prop);
      if (g.kind === 'title') expect(id.startsWith('title-')).toBe(true);
    }
    expect(lootGrant('hat-fedora')).toEqual({ kind: 'hat', hat: 'fedora' });
    expect(lootGrant('prop-watering-can')).toEqual({ kind: 'prop', prop: 'watering-can' });
  });
});

describe('schemas', () => {
  const hero = 'h-0123abcd';
  it('reject unknown keys', () => {
    expect(PartyRefSchema.safeParse({ kind: 'hero', heroId: hero, x: 1 }).success).toBe(false);
    expect(PartyRefSchema.safeParse({ kind: 'hero', heroId: hero }).success).toBe(true);
    expect(PartyRefSchema.safeParse({ kind: 'agent', agentId: 'a1' }).success).toBe(true);
    expect(PlayerActionSchema.safeParse({ t: 'run', x: 1 }).success).toBe(false);
    expect(PlayerActionSchema.safeParse({ t: 'move', move: 8 }).success).toBe(false);
    expect(PlayerActionSchema.safeParse({ t: 'item', item: 1, target: 2 }).success).toBe(true);
    expect(ProgressListQuerySchema.safeParse({ y: 1 }).success).toBe(false);
    expect(SkillAllocationSchema.safeParse({ skills: {}, y: 1 }).success).toBe(false);
    expect(TitleEquipSchema.safeParse({ title: null, y: 1 }).success).toBe(false);
    expect(TitleEquipSchema.safeParse({ title: 'title-unsold' }).success).toBe(true);
    expect(EmptyBodySchema.safeParse({ y: 1 }).success).toBe(false);
    expect(EmptyBodySchema.safeParse({}).success).toBe(true);
    const create = { projectId: 'p', npcKind: 'sales-dog', encounterId: 'sales-dog-1', party: [{ kind: 'hero', heroId: hero }] };
    expect(BattleCreateSchema.safeParse(create).success).toBe(true);
    expect(BattleCreateSchema.safeParse({ ...create, y: 1 }).success).toBe(false);
    expect(BattleCreateSchema.safeParse({ ...create, npcKind: 'janitor' }).success).toBe(false);
    expect(BattleCreateSchema.safeParse({ ...create, party: [] }).success).toBe(false);
    expect(BattleResolveSchema.safeParse({ log: [{ t: 'run' }], y: 1 }).success).toBe(false);
    expect(BattleResolveSchema.safeParse({ log: Array.from({ length: 221 }, () => ({ t: 'run' })) }).success).toBe(false);
    expect(BattleResolveSchema.safeParse({ log: [{ t: 'run' }], expect: { result: 'fled', turns: 1 } }).success).toBe(true);
  });
  it('reject __proto__ and malformed skill keys', () => {
    // zod drops a literal `__proto__` own key instead of failing: it never reaches the parsed value or the prototype.
    const p = SkillAllocationSchema.safeParse(JSON.parse('{"skills":{"__proto__":{"x":1},"developer.0.1":1}}'));
    expect(p.success && Object.keys(p.data.skills)).toEqual(['developer.0.1']);
    expect(p.success && Object.getPrototypeOf(p.data.skills)).toBeNull();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(SkillAllocationSchema.safeParse(JSON.parse('{"skills":{"constructor":1}}')).success).toBe(false);
    expect(SkillAllocationSchema.safeParse({ skills: { 'developer.0.1': 1 } }).success).toBe(true);
    expect(SkillAllocationSchema.safeParse({ skills: { 'developer.3.1': 1 } }).success).toBe(false);
    expect(SkillAllocationSchema.safeParse({ skills: { 'developer.0.1': 11 } }).success).toBe(false);
    const many = Object.fromEntries(CLASS_IDS.flatMap((c) => [0, 1, 2].flatMap((b) => [1, 2, 3, 4].map((t) => [`${c}.${b}.${t}`, 1]))));
    expect(Object.keys(many).length).toBe(96);
    expect(SkillAllocationSchema.safeParse({ skills: many }).success).toBe(false);
  });
  const progress = {
    heroId: hero, projectId: 'p', classId: 'developer', xp: 0, level: 1, levelXp: 0, nextLevelXp: 100, skillPoints: 0, bonusPoints: 0,
    skills: {}, overspent: false, koUntil: null, wins: 0, losses: 0, flees: 0, loot: [], equippedTitle: null, updatedAt: 1,
  };
  it('HeroProgressSchema', () => {
    expect(HeroProgressSchema.safeParse(progress).success).toBe(true);
    expect(HeroProgressSchema.safeParse({ ...progress, skills: { constructor: 1 } }).success).toBe(false);
    expect(HeroProgressSchema.safeParse({ ...progress, skills: { 'developer.0.1': 1 }, loot: ['hat-cap'] }).success).toBe(true);
    expect(HeroProgressSchema.safeParse({ ...progress, loot: ['nope'] }).success).toBe(false);
  });
  it('existing hero appearances still parse; loot fields optional', () => {
    const a = { skin: '#ffcc99', hairStyle: 0, hairColor: '#112233', outfitColor: null, hat: 'none', hatColor: null, prop: 'none', accessory: 'none', accessoryColor: null };
    const r = HeroAppearanceSchema.safeParse(a);
    expect(r.success).toBe(true);
    expect(HeroAppearanceSchema.safeParse({ ...a, lootHat: 'fedora', lootProp: null }).success).toBe(true);
    expect(HeroAppearanceSchema.safeParse({ ...a, lootHat: 'beanie' }).success).toBe(false);
  });
});

describe('M14 hardening', () => {
  const W = { output: 1, input: 1, cacheCreation: 1, cacheRead: 1 };
  const big = Number.MAX_SAFE_INTEGER;
  const U = (n: number) => ({ inputTokens: n, outputTokens: n, cacheReadTokens: n, cacheCreationTokens: n });
  it('limits', () => {
    expect(PROGRESSION_LIMITS).toMatchObject({ maxLog: 220, maxStoredBattles: 2000, maxCounter: 1e13, maxXp: 1e12, maxXpPerUpdate: 5_000_000 });
    expect(BattleResolveSchema.safeParse({ log: Array.from({ length: 220 }, () => ({ t: 'run' })) }).success).toBe(true);
  });
  it('xpFromUsage clamps counters and result', () => {
    expect(xpFromUsage(U(big), W)).toBeLessThanOrEqual(PROGRESSION_LIMITS.maxXp);
    expect(xpFromUsage(U(big * 4), { output: 1e9, input: 1e9, cacheCreation: 1e9, cacheRead: 1e9 })).toBe(PROGRESSION_LIMITS.maxXp);
    expect(xpFromUsage({ ...U(0), outputTokens: Infinity }, W)).toBe(0);
    expect(Number.isSafeInteger(xpFromUsage(U(big), W))).toBe(true);
  });
  it('advanceUsageMark stores clamped counters and caps the delta', () => {
    const r = advanceUsageMark(null, U(big), W);
    expect(r.mark).toEqual(U(PROGRESSION_LIMITS.maxCounter));
    expect(r.xpDelta).toBe(PROGRESSION_LIMITS.maxXpPerUpdate);
    const again = advanceUsageMark(r.mark, U(big), W);
    expect(again.changed).toBe(false);
    expect(again.xpDelta).toBe(0);
    expect(advanceUsageMark(U(big), U(1), W).mark).toEqual(U(PROGRESSION_LIMITS.maxCounter));
  });
  it('battle settings bounds', () => {
    expect(SettingsSchema.shape.battle.safeParse({ maxPerHour: 121 }).success).toBe(false);
    expect(SettingsSchema.shape.battle.safeParse({ retentionDays: 366 }).success).toBe(false);
    expect(SettingsSchema.shape.battle.parse({})).toMatchObject({ maxPerHour: 30, retentionDays: 30 });
  });
  it('skill allocation uses own keys only (null-prototype records)', () => {
    const p = SkillAllocationSchema.parse({ skills: { 'developer.0.1': 1 } });
    expect(Object.getPrototypeOf(p.skills)).toBeNull();
    expect(validateSkillAllocation(TREE, p.skills, Object.create(null), { level: 10, totalPoints: 5, allowRespec: true })).toEqual({ ok: true });
    expect(skillPointsSpent(p.skills)).toBe(1);
  });
});
