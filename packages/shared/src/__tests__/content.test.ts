import { describe, expect, it } from 'vitest';
import { BASIC_MOVE, CLASS_BASE, CLASS_IDS, CLASS_MOVES, CLASS_TYPE, ENEMIES, ITEMS, ITEM_IDS, LOOT_IDS, BATTLE_NPC_KINDS, MOVES, SKILL_TREES, type MoveDef } from '../index.js';

const FIELDS = ['id', 'type', 'category', 'target', 'power', 'hits', 'accuracy', 'focusCost', 'priority', 'critBonusPct', 'healPct', 'cure', 'status', 'self'].sort();

describe('content', () => {
  it('has 8 classes x 12 nodes with the template prerequisite chain', () => {
    expect(Object.keys(SKILL_TREES).sort()).toEqual([...CLASS_IDS].sort());
    for (const c of CLASS_IDS) {
      const nodes = SKILL_TREES[c].nodes;
      expect(nodes).toHaveLength(12);
      const ids = new Set(nodes.map((n) => n.id));
      expect(ids.size).toBe(12);
      nodes.forEach((n, k) => {
        expect(n.id).toBe(`${c}.${Math.floor(k / 4)}.${(k % 4) + 1}`);
        expect(n.maxRank).toBe([5, 1, 3, 1][n.tier - 1]);
        expect(n.minLevel).toBe([1, 3, 8, 15][n.tier - 1]);
        expect(n.requires).toEqual(n.tier === 1 ? [] : [{ id: `${c}.${n.branch}.${n.tier - 1}`, rank: 1 }]);
        expect(n.effect.kind === 'move').toBe(n.tier % 2 === 0);
      });
      expect(nodes.filter((n) => n.effect.kind === 'stat').map((n) => (n.effect as { stat: string }).stat)).toEqual(['atk', c === 'lead' ? 'hp' : 'def', 'spd']);
    }
  });
  it('template exceptions: qa heal boost, analyst type boost', () => {
    expect(SKILL_TREES.qa.nodes[2]?.effect.kind).toBe('healBoost');
    expect(SKILL_TREES.analyst.nodes[10]?.effect.kind).toBe('typeBoost');
    expect(SKILL_TREES.developer.nodes[2]?.effect.kind).toBe('crit');
  });
  it('every referenced move exists; a fully skilled hero has <= 8 moves', () => {
    for (const c of CLASS_IDS) {
      expect(MOVES[BASIC_MOVE[c]]).toBeDefined();
      for (const id of CLASS_MOVES[c]) expect(MOVES[id]).toBeDefined();
      const moves = SKILL_TREES[c].nodes.flatMap((n) => (n.effect.kind === 'move' ? [n.effect.moveId] : []));
      expect(moves).toEqual([...CLASS_MOVES[c]]);
      expect(moves.length + 1).toBeLessThanOrEqual(8);
      expect(CLASS_BASE[c].hp).toBeGreaterThan(0);
    }
    for (const e of Object.values(ENEMIES)) for (const id of e.moves) expect(MOVES[id]).toBeDefined();
  });
  it('every MoveDef has every field and sane values', () => {
    for (const m of Object.values(MOVES) as MoveDef[]) {
      expect(Object.keys(m).sort()).toEqual(FIELDS);
      expect(m.id).toMatch(/^[a-z][a-z0-9-]{1,31}$/);
      expect(m.accuracy).toBeGreaterThanOrEqual(1);
      expect(m.accuracy).toBeLessThanOrEqual(100);
      if (m.category !== 'attack') expect(m.power).toBe(0);
      if (m.category === 'attack') expect(m.power).toBeGreaterThan(0);
      if (m.status) expect(m.status.turns[0]).toBeLessThanOrEqual(m.status.turns[1]);
    }
  });
  it('class moves use the class type, supports are neutral', () => {
    expect(MOVES.hotfix?.type).toBe(CLASS_TYPE.developer);
    expect(MOVES['rubber-duck']?.type).toBe('neutral');
    expect(MOVES['commit']).toMatchObject({ power: 40, accuracy: 100, focusCost: 0 });
    expect(MOVES['quick-deploy']?.priority).toBe(1);
    expect(MOVES['fuzz-barrage']).toMatchObject({ hits: 3, power: 30 });
    expect(MOVES['crunch-time']?.self).toEqual({ id: 'burnout', turns: 2 });
    expect(MOVES['team-lunch']).toMatchObject({ target: 'party', healPct: 30 });
  });
  it('every enemy has 4 moves, a basic P40 first, loot; every loot id drops somewhere', () => {
    expect(Object.keys(ENEMIES).sort()).toEqual([...BATTLE_NPC_KINDS].sort());
    const drops = new Set<string>();
    for (const [k, e] of Object.entries(ENEMIES)) {
      expect(e.kind).toBe(k);
      expect(e.moves).toHaveLength(4);
      expect(MOVES[e.moves[0] as string]).toMatchObject({ power: 40, accuracy: 100 });
      expect(e.loot.length).toBeGreaterThanOrEqual(1);
      for (const l of e.loot) { drops.add(l.id); expect(l.weight).toBeGreaterThan(0); }
    }
    for (const id of LOOT_IDS) expect(drops.has(id)).toBe(true);
  });
  it('items', () => {
    expect(Object.keys(ITEMS)).toEqual([...ITEM_IDS]);
    expect(ITEMS.pizza).toEqual({ id: 'pizza', effect: 'heal-party', pct: 25 });
  });
  it('MOVES has no prototype', () => {
    expect(MOVES['__proto__']).toBeUndefined();
    expect(MOVES['toString']).toBeUndefined();
  });
});
