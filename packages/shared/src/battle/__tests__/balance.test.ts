// W0d: balance simulation (docs/design/battles.md section 4). The real engine + content + setup, a greedy bot, many seeds.
import { describe, expect, it } from 'vitest';
import { BATTLE_NPC_KINDS, CLASS_IDS, CLASS_TYPE, xpForLevel, type BattleNpcKind, type ClassId, type EnemyType, type LevelCurve, type SkillAllocation } from '../../progression.js';
import { ENEMIES, SKILL_TREES } from '../../progressionContent.js';
import { applyAction, createBattle, damagePreview, legalActions } from '../engine.js';
import { buildBattleSetup } from '../setup.js';
import { typeEffect, type BattleResult, type BattleSetup, type BattleState, type PlayerAction } from '../types.js';

const CURVE: LevelCurve = { levelBase: 1500, levelExponent: 2, maxLevel: 50 };
const ITEMS = { coffee: 2, energyDrink: 1, rubberDuck: 1, pizza: 0 }; // settings defaults
const MAX_TURNS = 60;
const SEEDS = 300;

/** Spend (level - 1) points: moves first (with their prerequisite), then offense, defense, tempo ranks. */
function allocate(classId: ClassId, level: number): SkillAllocation {
  const nodes = SKILL_TREES[classId].nodes;
  const ranks: Record<string, number> = {};
  let points = level - 1;
  const rank = (id: string): number => ranks[id] ?? 0;
  const buy = (n: (typeof nodes)[number]): boolean => {
    if (points <= 0 || rank(n.id) >= n.maxRank || level < n.minLevel || !n.requires.every((r) => rank(r.id) >= r.rank)) return false;
    ranks[n.id] = rank(n.id) + 1;
    points--;
    return true;
  };
  const byId = new Map(nodes.map((n) => [n.id as string, n]));
  const moves = nodes.filter((n) => n.effect.kind === 'move').sort((a, b) => a.tier - b.tier || a.branch - b.branch);
  for (const m of moves) {
    for (const r of m.requires) { const p = byId.get(r.id); if (p) while (rank(p.id) < r.rank && buy(p)) { /* prerequisite */ } }
    buy(m);
  }
  for (let again = true; again && points > 0; ) {
    again = false;
    for (const n of nodes) if (n.effect.kind !== 'move' && buy(n)) again = true;
  }
  return ranks;
}

/** Greedy policy: coffee below 35 % HP, else the affordable attack with the best expected damage; forced swap to the healthiest. */
function choose(setup: BattleSetup, s: BattleState): PlayerAction {
  const legal = legalActions(setup, s);
  if (s.phase === 'forced-swap') {
    let best = legal[0] as PlayerAction;
    let bestFrac = -1;
    for (const a of legal) {
      if (a.t !== 'swap') continue;
      const frac = (s.party[a.to] as BattleState['party'][number]).hp / (setup.party[a.to] as BattleSetup['party'][number]).stats.hp;
      if (frac > bestFrac) { bestFrac = frac; best = a; }
    }
    return best;
  }
  const me = s.party[s.active] as BattleState['party'][number];
  const maxHp = (setup.party[s.active] as BattleSetup['party'][number]).stats.hp;
  if (me.hp * 100 < 35 * maxHp) {
    const coffee = legal.find((a) => a.t === 'item' && (setup.items[a.item]?.def.id === 'coffee') && (a.target ?? s.active) === s.active);
    if (coffee) return coffee;
  }
  const moves = (setup.party[s.active] as BattleSetup['party'][number]).moves;
  let best: PlayerAction = { t: 'move', move: 0 };
  let bestVal = -1;
  for (const a of legal) {
    if (a.t !== 'move') continue;
    const def = moves[a.move];
    const p = damagePreview(setup, s, a.move);
    if (!def || !p) continue;
    const val = ((p.min + p.max) / 2) * (def.accuracy / 100);
    if (val > bestVal) { bestVal = val; best = a; }
  }
  return best;
}

function fight(setup: BattleSetup): { result: BattleResult; turns: number } {
  let s = createBattle(setup);
  for (let i = 0; i < 1000 && s.phase !== 'ended'; i++) {
    const r = applyAction(setup, s, choose(setup, s));
    if (!r.ok) throw new Error(`bot made an illegal action: ${r.error}`);
    s = r.state;
  }
  return { result: s.result as BattleResult, turns: s.turn - 1 };
}

/** Classes whose attack type and the enemy's type are neutral both ways. */
const neutralClasses = (enemyType: EnemyType): ClassId[] =>
  CLASS_IDS.filter((c) => typeEffect(CLASS_TYPE[c], enemyType) === 1000 && typeEffect(enemyType, CLASS_TYPE[c]) === 1000);

interface Stat { n: number; winRate: number; median: number; p90: number; timeouts: number; lost: number }
function summarize(rows: { result: BattleResult; turns: number }[]): Stat {
  const t = rows.map((r) => r.turns).sort((a, b) => a - b);
  const at = (q: number): number => t[Math.min(t.length - 1, Math.floor(q * t.length))] as number;
  return {
    n: rows.length, winRate: rows.filter((r) => r.result === 'won').length / rows.length, median: at(0.5), p90: at(0.9),
    timeouts: rows.filter((r) => r.result === 'timeout').length / rows.length, lost: rows.filter((r) => r.result === 'lost').length / rows.length,
  };
}

/** SEEDS battles at (party size, level, difficulty): enemy kind and neutral party classes rotate with the seed. */
function cell(size: number, level: number, difficulty: number, neutral = true): Stat {
  const rows: { result: BattleResult; turns: number }[] = [];
  for (let k = 0; k < SEEDS; k++) {
    const npcKind = BATTLE_NPC_KINDS[k % BATTLE_NPC_KINDS.length] as BattleNpcKind;
    const pool = neutral ? neutralClasses(ENEMIES[npcKind].type as EnemyType) : [...CLASS_IDS];
    const party = Array.from({ length: size }, (_, j) => {
      const classId = pool[(k + j) % pool.length] as ClassId;
      return { ref: { kind: 'agent' as const, agentId: `a${j}` }, name: classId, role: classId, xp: xpForLevel(level, CURVE), skills: allocate(classId, level), temporary: false };
    });
    const seed = Math.imul(k + 1, 2654435761) >>> 0;
    rows.push(fight(buildBattleSetup({ seed, npcKind, party, curve: CURVE, difficulty, items: ITEMS, maxTurns: MAX_TURNS })));
  }
  return summarize(rows);
}

const LEVELS = [5, 15, 30];
const SIZES = [1, 2, 3, 4];
const d1 = new Map<string, Stat>();
const d2 = new Map<string, Stat>();
for (const size of SIZES) for (const level of LEVELS) { d1.set(`${size}/${level}`, cell(size, level, 1)); d2.set(`${size}/${level}`, cell(size, level, 2)); }
const report = (name: string, m: Map<string, Stat>): void => {
  for (const [k, v] of m) console.log(name, 'size/level', k, JSON.stringify(v, (_, x: unknown) => (typeof x === 'number' ? Math.round(x * 1000) / 1000 : x)));
};
if (process.env.BALANCE_REPORT) {
  report('difficulty 1', d1);
  report('difficulty 2', d2);
  for (const size of SIZES) for (const level of LEVELS) console.log('mixed types, difficulty 1', `${size}/${level}`, JSON.stringify(cell(size, level, 1, false)));
}

describe('balance (greedy bot, neutral matchups, 300 seeds per cell)', () => {
  it('battles last about 4-8 turns at difficulty 1', () => {
    for (const [k, v] of d1) {
      expect(v.median, `median turns ${k}`).toBeGreaterThanOrEqual(4);
      expect(v.median, `median turns ${k}`).toBeLessThanOrEqual(8);
    }
  });
  it('a party of 1 wins 55-90 % at difficulty 1', () => {
    for (const level of LEVELS) {
      const v = d1.get(`1/${level}`) as Stat;
      expect(v.winRate, `win rate 1/${level}`).toBeGreaterThanOrEqual(0.55);
      expect(v.winRate, `win rate 1/${level}`).toBeLessThanOrEqual(0.9);
    }
  });
  // Upper bound is 1, not the design's 0.98: with a bench the enemy cannot finish 2-4 hero pools inside 8 turns (see 4.6 notes).
  it('parties of 2-4 win at least 70 % at difficulty 1', () => {
    for (const size of [2, 3, 4]) for (const level of LEVELS) expect((d1.get(`${size}/${level}`) as Stat).winRate, `win rate ${size}/${level}`).toBeGreaterThanOrEqual(0.7);
  });
  it('a bigger party never makes the battle easier to lose', () => {
    for (const level of LEVELS) for (const size of [2, 3, 4]) expect((d1.get(`${size}/${level}`) as Stat).winRate).toBeGreaterThanOrEqual((d1.get(`${size - 1}/${level}`) as Stat).winRate - 0.02);
  });
  it('difficulty 2 is harder than difficulty 1 in every cell', () => {
    for (const [k, v] of d2) expect(v.winRate, `difficulty 2 ${k}`).toBeLessThan((d1.get(k) as Stat).winRate);
  });
  it('timeouts stay under 1 %', () => {
    for (const m of [d1, d2]) for (const [k, v] of m) expect(v.timeouts, `timeouts ${k}`).toBeLessThan(0.01);
  });
});
