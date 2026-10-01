import { ENGINE_VERSION, type BattleSetup, type CombatMods, type CombatantSetup, type PlayerAction } from '../types.js';
import type { ItemDef, MoveDef, Stats } from '../../progression.js';
import { rngNext } from '../rng.js';

/** Hand-built fixtures: the engine tests never depend on progressionContent. */
export const NO_MODS: CombatMods = { critPct: 0, focusRegen: 0, statusResistPct: 0, healBoostPct: 0, typeBoostPct: 0 };

export function mv(id: string, o: Partial<MoveDef> = {}): MoveDef {
  return { id, type: 'neutral', category: 'attack', target: 'enemy', power: 40, hits: 1, accuracy: 100, focusCost: 0, priority: 0, critBonusPct: 0, healPct: 0, cure: false, status: null, self: null, ...o };
}

export const M = {
  basic: mv('commit', { type: 'build' }),
  strong: mv('hotfix', { type: 'build', power: 70, accuracy: 90, focusCost: 8 }),
  quick: mv('quick-deploy', { type: 'build', power: 50, priority: 1, focusCost: 6 }),
  multi: mv('nitpick', { type: 'review', power: 25, hits: 3, accuracy: 95, focusCost: 8 }),
  heal: mv('lgtm', { category: 'heal', target: 'self', power: 0, healPct: 40, focusCost: 10 }),
  partyHeal: mv('team-lunch', { category: 'heal', target: 'party', power: 0, healPct: 30, focusCost: 14 }),
  shield: mv('brace', { category: 'shield', target: 'self', power: 0, focusCost: 8, self: { id: 'shielded', turns: 3 } }),
  buff: mv('standup-buff', { category: 'buff', target: 'self', power: 0, focusCost: 6, self: { id: 'buffed', turns: 3 } }),
  stun: mv('whiteboard-trap', { category: 'status', power: 0, accuracy: 100, focusCost: 8, status: { id: 'stunned', chancePct: 100, turns: [1, 1] } }),
  conflict: mv('merge', { category: 'status', power: 0, status: { id: 'merge-conflict', chancePct: 100, turns: [2, 3] } }),
  burnout: mv('storm', { category: 'status', power: 0, status: { id: 'burnout', chancePct: 100, turns: [3, 5] } }),
  maybe: mv('maybe-stun', { category: 'status', power: 0, status: { id: 'stunned', chancePct: 50, turns: [1, 1] } }),
  crunch: mv('crunch-time', { power: 120, self: { id: 'burnout', turns: 2 } }),
  cureHeal: mv('rubber-duck', { category: 'heal', target: 'self', power: 0, healPct: 40, cure: true }),
} as const;

export const COFFEE: ItemDef = { id: 'coffee', effect: 'heal', pct: 40 };
export const DRINK: ItemDef = { id: 'energy-drink', effect: 'focus', pct: 50 };
export const DUCK: ItemDef = { id: 'rubber-duck', effect: 'cure', pct: 0 };
export const PIZZA: ItemDef = { id: 'pizza', effect: 'heal-party', pct: 25 };

export function stats(o: Partial<Stats> = {}): Stats {
  return { hp: 60, atk: 30, def: 20, spd: 30, focus: 40, ...o };
}

export function hero(o: Partial<CombatantSetup> = {}): CombatantSetup {
  return {
    ref: { kind: 'agent', agentId: 'a1' }, name: 'Dev', classId: 'developer', type: 'build', level: 10, stats: stats(),
    moves: [M.basic, M.strong, M.heal, M.shield, M.buff, M.quick], mods: NO_MODS, ai: null, temporary: false, ...o,
  };
}

export function enemy(o: Partial<CombatantSetup> = {}): CombatantSetup {
  return {
    ref: { kind: 'enemy', npcKind: 'monster' }, name: 'monster', classId: null, type: 'bug', level: 10, stats: stats({ hp: 90, spd: 25 }),
    moves: [mv('segfault', { type: 'bug' }), M.stun, mv('shield-up', { category: 'shield', target: 'self', power: 0, self: { id: 'shielded', turns: 2 } })],
    mods: NO_MODS, ai: 'aggressive', temporary: false, ...o,
  };
}

export function setup(o: Partial<BattleSetup> = {}): BattleSetup {
  return {
    engineVersion: ENGINE_VERSION, seed: 12345, party: [hero(), hero({ ref: { kind: 'agent', agentId: 'a2' }, name: 'QA' })], enemy: enemy(),
    items: [{ def: COFFEE, count: 2 }, { def: DRINK, count: 1 }, { def: DUCK, count: 1 }, { def: PIZZA, count: 1 }], maxTurns: 30, ...o,
  };
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Seeded picker for the tests themselves (not the engine). */
export function testRng(seed: number): (n: number) => number {
  let st = seed >>> 0;
  return (n) => {
    const r = rngNext(st);
    st = r.state;
    return r.value % n;
  };
}

export const MOVE0: PlayerAction = { t: 'move', move: 0 };
