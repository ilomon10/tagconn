// M14 setup builder, scaling and outcome (docs/design/battles.md 1.7, 4.2, 4.6, 4.7). Pure, integer math where it matters.
import {
  CLASS_TYPE, ITEM_IDS, PROGRESSION_LIMITS, classForRole, levelForXp, levelSpan, skillPointsSpent, skillPointsTotal,
  type BattleNpcKind, type ClassId, type HeroAward, type HeroProgress, type HeroProgressCore, type ItemCounts, type LevelCurve, type LootId,
  type MoveDef, type PartyRef, type SkillAllocation, type Stats,
} from '../progression.js';
import { BASIC_MOVE, CLASS_BASE, ENEMIES, ITEMS, MOVES, SKILL_TREES } from '../progressionContent.js';
import { ENGINE_VERSION, type BattleResult, type BattleSetup, type BattleState, type CombatMods, type CombatantSetup } from './types.js';
import { rngNext, seedState } from './rng.js';

const nullProto = <T>(o: Record<string, T> = {}): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, o);

/** Own, positive-integer rank of `id` in `skills` (never reads the prototype), clamped to `maxRank`. */
function rankOf(skills: SkillAllocation, id: string, maxRank: number): number {
  if (!Object.hasOwn(skills, id)) return 0;
  const r = skills[id];
  return typeof r === 'number' && Number.isInteger(r) && r >= 1 ? Math.min(r, maxRank) : 0;
}

/** Section 4.2 from base stats B at level L (no passives). `focus` is the max FOCUS pool. */
export function statsFromBase(b: Stats, level: number): Stats {
  const l = Math.max(1, Math.floor(level));
  const core = (x: number): number => Math.floor((2 * x * l) / 100) + 5;
  return { hp: Math.floor((2 * b.hp * l) / 100) + l + 10, atk: core(b.atk), def: core(b.def), spd: core(b.spd), focus: Math.floor((b.focus * l) / 50) + 10 };
}
export function statsFor(classId: ClassId, level: number, skills: SkillAllocation): Stats {
  const s = statsFromBase(CLASS_BASE[classId], level);
  const pct = { hp: 0, atk: 0, def: 0, spd: 0 };
  for (const n of SKILL_TREES[classId].nodes) {
    if (n.effect.kind === 'stat') pct[n.effect.stat] += n.effect.pctPerRank * rankOf(skills, n.id, n.maxRank);
  }
  const up = (v: number, p: number): number => Math.floor((v * (100 + p)) / 100);
  return { hp: up(s.hp, pct.hp), atk: up(s.atk, pct.atk), def: up(s.def, pct.def), spd: up(s.spd, pct.spd), focus: s.focus };
}
export function combatModsFor(classId: ClassId, skills: SkillAllocation): CombatMods {
  const m: CombatMods = { critPct: 0, focusRegen: 0, statusResistPct: 0, healBoostPct: 0, typeBoostPct: 0 };
  for (const n of SKILL_TREES[classId].nodes) {
    const r = rankOf(skills, n.id, n.maxRank);
    if (r === 0) continue;
    const e = n.effect;
    if (e.kind === 'crit') m.critPct += e.pctPerRank * r;
    else if (e.kind === 'focusRegen') m.focusRegen += e.perRank * r;
    else if (e.kind === 'statusResist') m.statusResistPct += e.pctPerRank * r;
    else if (e.kind === 'healBoost') m.healBoostPct += e.pctPerRank * r;
    else if (e.kind === 'typeBoost') m.typeBoostPct += e.pctPerRank * r;
  }
  return m;
}
/** Basic move + unlocked moves in tree order (<= 8). */
export function movesFor(classId: ClassId, skills: SkillAllocation): MoveDef[] {
  const out = [MOVES[BASIC_MOVE[classId]] as MoveDef];
  for (const n of SKILL_TREES[classId].nodes) {
    if (n.effect.kind === 'move' && rankOf(skills, n.id, n.maxRank) >= 1) out.push(MOVES[n.effect.moveId] as MoveDef);
  }
  return out.slice(0, PROGRESSION_LIMITS.maxMoves);
}
/** Only this class's valid ranks, as a null-prototype record (drops other classes' ids and reserved keys). */
export function skillsForClass(classId: ClassId, skills: SkillAllocation): SkillAllocation {
  const out = nullProto<number>();
  for (const n of SKILL_TREES[classId].nodes) {
    if (!Object.hasOwn(skills, n.id)) continue;
    const r = skills[n.id];
    if (typeof r === 'number' && Number.isInteger(r) && r >= 1) out[n.id] = r;
  }
  return out;
}

// ------------------------------------------------------------------ enemy scaling

export const enemyHpPct = (partySize: number): number => 130 + 15 * (partySize - 1);
/** clamp(round(avg * difficulty) + spread, 1, maxLevel + 5), spread = rng % 4 - 1 (-1..+2). */
export function enemyLevelFor(avgLevel: number, difficulty: number, seed: number, maxLevel: number): number {
  const spread = (rngNext(seedState(seed, 0x5bd1e995)).value % 4) - 1;
  return Math.min(Math.max(1, Math.floor(maxLevel) + 5), Math.max(1, Math.round(avgLevel * difficulty) + spread));
}

// ------------------------------------------------------------------ setup

export interface PartyMemberInput { ref: PartyRef; name: string; role: string; xp: number; skills: SkillAllocation; temporary: boolean }
export interface BuildSetupInput { seed: number; npcKind: BattleNpcKind; party: readonly PartyMemberInput[]; curve: LevelCurve; difficulty: number; items: ItemCounts; maxTurns: number }

const cleanName = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 40) || 'Hero';
const NO_MODS: CombatMods = { critPct: 0, focusRegen: 0, statusResistPct: 0, healBoostPct: 0, typeBoostPct: 0 };

export function buildBattleSetup(i: BuildSetupInput): BattleSetup {
  const members = i.party.slice(0, PROGRESSION_LIMITS.maxParty);
  if (members.length === 0) throw new RangeError('empty party');
  const seed = i.seed >>> 0;
  const levels = members.map((m) => levelForXp(m.xp, i.curve));
  // F13: an anonymous member counts at most at the highest hero level (its own level when there is no hero).
  let topHero = 0;
  members.forEach((m, k) => { if (!m.temporary) topHero = Math.max(topHero, levels[k] as number); });
  const avg = members.reduce((sum, m, k) => sum + (m.temporary && topHero > 0 ? Math.min(levels[k] as number, topHero) : (levels[k] as number)), 0) / members.length;

  const party: CombatantSetup[] = members.map((m, k) => {
    const classId = classForRole(m.role);
    const skills = skillsForClass(classId, m.skills);
    const level = levels[k] as number;
    return {
      ref: m.ref, name: cleanName(m.name), classId, type: CLASS_TYPE[classId], level, stats: statsFor(classId, level, skills),
      moves: movesFor(classId, skills), mods: combatModsFor(classId, skills), ai: null, temporary: m.temporary,
    };
  });

  const def = ENEMIES[i.npcKind];
  const level = enemyLevelFor(avg, i.difficulty, seed, i.curve.maxLevel);
  const base = statsFromBase(def.base, level);
  const enemy: CombatantSetup = {
    ref: { kind: 'enemy', npcKind: i.npcKind }, name: i.npcKind, classId: null, type: def.type, level,
    stats: { ...base, hp: Math.max(1, Math.floor((base.hp * enemyHpPct(members.length)) / 100)) },
    moves: def.moves.map((id) => MOVES[id] as MoveDef), mods: { ...NO_MODS }, ai: def.ai, temporary: false,
  };

  const counts: Record<(typeof ITEM_IDS)[number], number> = { coffee: i.items.coffee, 'energy-drink': i.items.energyDrink, 'rubber-duck': i.items.rubberDuck, pizza: i.items.pizza };
  const items = ITEM_IDS.flatMap((id) => {
    const count = Math.min(9, Math.max(0, Math.floor(counts[id]) || 0));
    return count > 0 ? [{ def: ITEMS[id], count }] : [];
  });
  return { engineVersion: ENGINE_VERSION, seed, party, enemy, items, maxTurns: i.maxTurns };
}

// ------------------------------------------------------------------ outcome

/** round(levelBase * L * xpScale); half (floored) when the hero fainted. */
export function battleXp(enemyLevel: number, levelBase: number, xpScale: number, fainted: boolean): number {
  const full = Math.max(0, Math.round(levelBase * enemyLevel * xpScale));
  return fainted ? Math.floor(full / 2) : full;
}
export interface OutcomeConfig { curve: LevelCurve; skillPointsPerLevel: number; xpScale: number; koMinutes: number; skillPointEveryWins: number; lootChance: number }
export interface OutcomeInput {
  setup: BattleSetup; final: BattleState; result: BattleResult; turns: number;
  /** Server-only uint32 (F4): stored on the battle row, never in `BattleSetup`, `BattleStart` or GET responses. */
  lootSeed: number;
  heroes: readonly { heroId: string; memberIndex: number; core: HeroProgressCore }[];
  cfg: OutcomeConfig; now: number;
}

export function computeOutcome(i: OutcomeInput): { awards: HeroAward[]; loot: { heroId: string; lootId: LootId } | null; next: Record<string, HeroProgressCore> } {
  const { cfg, result } = i;
  const koMs = cfg.koMinutes > 0 ? Math.round(cfg.koMinutes * 60_000) : 0;
  const next = nullProto<HeroProgressCore>();
  const awards: HeroAward[] = [];
  const fainted = (memberIndex: number): boolean => i.final.party[memberIndex]?.fainted === true;

  for (const h of i.heroes) {
    const down = fainted(h.memberIndex);
    const levelBefore = levelForXp(h.core.xp, cfg.curve);
    let xp = h.core.xp;
    let wins = h.core.wins;
    let bonus = 0;
    if (result === 'won') {
      const gain = Math.min(battleXp(Math.min(i.setup.enemy.level, levelBefore + 5), cfg.curve.levelBase, cfg.xpScale, down), PROGRESSION_LIMITS.maxXpPerUpdate);
      xp = Math.min(PROGRESSION_LIMITS.maxXp, h.core.xp + gain);
      wins += 1;
      if (cfg.skillPointEveryWins > 0 && wins % cfg.skillPointEveryWins === 0) bonus = 1;
    }
    const knockedOut = koMs > 0 && (result === 'lost' || down);
    const levelAfter = levelForXp(xp, cfg.curve);
    const core: HeroProgressCore = {
      ...h.core,
      xp, wins, bonusPoints: h.core.bonusPoints + bonus,
      losses: h.core.losses + (result === 'lost' ? 1 : 0),
      flees: h.core.flees + (result === 'fled' || result === 'timeout' ? 1 : 0),
      koUntil: knockedOut ? Math.max(h.core.koUntil ?? 0, i.now + koMs) : h.core.koUntil,
      skills: nullProto<number>(h.core.skills as Record<string, number>),
      loot: [...h.core.loot],
      updatedAt: i.now,
    };
    next[h.heroId] = Object.assign(Object.create(null) as HeroProgressCore, core);
    awards.push({
      heroId: h.heroId, memberIndex: h.memberIndex, xpGained: xp - h.core.xp, levelBefore, levelAfter,
      skillPointsGained: (levelAfter - levelBefore) * cfg.skillPointsPerLevel + bonus, fainted: down, koUntil: knockedOut ? core.koUntil : null,
    });
  }

  let loot: { heroId: string; lootId: LootId } | null = null;
  const enemyKind = i.setup.enemy.ref.kind === 'enemy' ? i.setup.enemy.ref.npcKind : null;
  if (result === 'won' && enemyKind && i.heroes.length > 0) {
    // Separate server-only stream (F4): independent of draws inside the battle.
    let st = seedState(i.lootSeed, 0x27d4eb2f);
    const draw = (): number => { const r = rngNext(st); st = r.state; return r.value; };
    if (draw() % 1000 < Math.round(cfg.lootChance * 1000)) {
      const alive = i.heroes.filter((h) => !fainted(h.memberIndex));
      const pool = alive.length > 0 ? alive : i.heroes;
      const recipient = pool[draw() % pool.length] as (typeof i.heroes)[number];
      const owned = new Set<string>(next[recipient.heroId]?.loot ?? []);
      const options = ENEMIES[enemyKind].loot.filter((l) => !owned.has(l.id) && l.weight > 0);
      const total = options.reduce((s, l) => s + l.weight, 0);
      if (total > 0) {
        let roll = draw() % total;
        const pick = options.find((l) => (roll -= l.weight) < 0) ?? options[options.length - 1];
        if (pick) {
          loot = { heroId: recipient.heroId, lootId: pick.id };
          (next[recipient.heroId] as HeroProgressCore).loot = [...(next[recipient.heroId] as HeroProgressCore).loot, pick.id];
        }
      }
    }
  }
  return { awards, loot, next };
}

export function emptyCore(role: string, now: number): HeroProgressCore {
  return { classId: classForRole(role), xp: 0, bonusPoints: 0, skills: nullProto<number>(), koUntil: null, wins: 0, losses: 0, flees: 0, loot: [], equippedTitle: null, updatedAt: now };
}

export function progressView(heroId: string, projectId: string, role: string, core: HeroProgressCore, cfg: { curve: LevelCurve; skillPointsPerLevel: number }): HeroProgress {
  const classId = classForRole(role);
  const skills = classId === core.classId ? skillsForClass(classId, core.skills) : nullProto<number>();
  const { level, levelXp, nextLevelXp } = levelSpan(core.xp, cfg.curve);
  const total = skillPointsTotal(level, cfg.skillPointsPerLevel, core.bonusPoints);
  const spent = skillPointsSpent(skills);
  return {
    heroId, projectId, classId, xp: core.xp, level, levelXp, nextLevelXp, skillPoints: Math.max(0, total - spent), bonusPoints: core.bonusPoints,
    skills, overspent: spent > total, koUntil: core.koUntil, wins: core.wins, losses: core.losses, flees: core.flees,
    loot: [...core.loot], equippedTitle: core.equippedTitle, updatedAt: core.updatedAt,
  };
}
