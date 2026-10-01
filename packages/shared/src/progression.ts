import { z } from 'zod';
import type { TokenUsage } from './domain.js';
import { HERO_ID_RE, type LootHat, type LootProp } from './heroes.js';
import { MAIN_ROLE } from './roles.js';
import type { NpcKind } from './settings.js';
import { BATTLE_RESULTS, PartyRefSchema, PlayerActionSchema, type BattleResult, type BattleSetup, type PartyRef } from './battle/types.js';

// ------------------------------------------------------------------ classes, stats, types

export const CLASS_IDS = ['developer', 'qa', 'architect', 'security', 'reviewer', 'analyst', 'lead', 'adventurer'] as const;
export type ClassId = (typeof CLASS_IDS)[number];

/** Own-property lookup (null-prototype object); unknown roles → 'adventurer'. MAIN_ROLE ('pm') → 'lead'. */
const ROLE_CLASS: Readonly<Record<string, ClassId>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, ClassId>, {
    developer: 'developer', 'devops-engineer': 'developer', 'qa-engineer': 'qa', architect: 'architect',
    'security-engineer': 'security', 'code-reviewer': 'reviewer', analyst: 'analyst', 'tech-writer': 'analyst',
    [MAIN_ROLE]: 'lead',
  }),
);
export function classForRole(role: string): ClassId {
  return ROLE_CLASS[role] ?? 'adventurer';
}

export const STAT_IDS = ['hp', 'atk', 'def', 'spd', 'focus'] as const;
export type StatId = (typeof STAT_IDS)[number];
export type Stats = Readonly<Record<StatId, number>>;

export const HERO_TYPES = ['build', 'test', 'design', 'secure', 'review', 'insight', 'lead', 'grit'] as const;
export type HeroType = (typeof HERO_TYPES)[number];
export const ENEMY_TYPES = ['bug', 'bureaucrat', 'salesy', 'rival', 'feral'] as const;
export type EnemyType = (typeof ENEMY_TYPES)[number];
export type BattleType = HeroType | EnemyType | 'neutral';
export const CLASS_TYPE: Readonly<Record<ClassId, HeroType>> = {
  developer: 'build', qa: 'test', architect: 'design', security: 'secure', reviewer: 'review', analyst: 'insight', lead: 'lead', adventurer: 'grit',
};

/** M13 NPC kinds that can be battled (routine staff never are). */
export const BATTLE_NPC_KINDS = ['guest', 'police', 'cia-agent', 'sales-dog', 'monster', 'office-cat'] as const satisfies readonly NpcKind[];
export type BattleNpcKind = (typeof BATTLE_NPC_KINDS)[number];
export const isBattleNpcKind = (k: string): k is BattleNpcKind => (BATTLE_NPC_KINDS as readonly string[]).includes(k);

// ------------------------------------------------------------------ statuses, moves, items

export const MAJOR_STATUSES = ['stunned', 'merge-conflict', 'burnout'] as const;
export type MajorStatus = (typeof MAJOR_STATUSES)[number];

/** Every field is required (stable JSON in stored setups). */
export interface MoveDef {
  id: string; // /^[a-z][a-z0-9-]{1,31}$/
  type: BattleType;
  category: 'attack' | 'heal' | 'buff' | 'shield' | 'status';
  target: 'enemy' | 'self' | 'party';
  power: number; // 0 for non-attacks
  hits: 1 | 2 | 3;
  accuracy: number; // 1..100; 100 never rolls
  focusCost: number; // enemies ignore focus
  priority: 0 | 1;
  critBonusPct: number;
  healPct: number; // heal/party heal, % of max HP
  cure: boolean; // clears the user's major status
  /** Inflicted on the target after a hit (or as the move for category 'status'). */
  status: { id: MajorStatus; chancePct: number; turns: readonly [number, number] } | null;
  /** Applied to the user after the move ('burnout' = crunch-time's drawback). */
  self: { id: 'buffed' | 'shielded' | 'burnout'; turns: number } | null;
}

export const ITEM_IDS = ['coffee', 'energy-drink', 'rubber-duck', 'pizza'] as const;
export type ItemId = (typeof ITEM_IDS)[number];
export interface ItemDef { id: ItemId; effect: 'heal' | 'focus' | 'cure' | 'heal-party'; pct: number }
/** Same shape as `settings.battle.items`. */
export interface ItemCounts { coffee: number; energyDrink: number; rubberDuck: number; pizza: number }

// ------------------------------------------------------------------ skill trees

/** `${classId}.${branch}.${tier}`, e.g. 'developer.0.2'. The regex also keeps reserved JS keys out of skill records. */
export const SKILL_ID_RE = /^(developer|qa|architect|security|reviewer|analyst|lead|adventurer)\.[0-2]\.[1-4]$/;
export type SkillId = `${ClassId}.${0 | 1 | 2}.${1 | 2 | 3 | 4}`;
/** SkillId → rank (>= 1). Ranks of 0 are omitted. */
export type SkillAllocation = Readonly<Record<string, number>>;

export type SkillEffect =
  | { kind: 'stat'; stat: Exclude<StatId, 'focus'>; pctPerRank: number }
  | { kind: 'move'; moveId: string }
  | { kind: 'crit'; pctPerRank: number }
  | { kind: 'focusRegen'; perRank: number }
  | { kind: 'statusResist'; pctPerRank: number }
  | { kind: 'healBoost'; pctPerRank: number }
  | { kind: 'typeBoost'; pctPerRank: number };

export interface SkillNode {
  id: SkillId;
  classId: ClassId;
  branch: 0 | 1 | 2;
  tier: 1 | 2 | 3 | 4;
  maxRank: number;
  minLevel: number;
  requires: readonly { id: SkillId; rank: number }[];
  effect: SkillEffect;
}
export interface SkillTree { classId: ClassId; nodes: readonly SkillNode[] } // 12 nodes, branch-major, tier-ascending

export type SkillCheckCode = 'unknown-skill' | 'rank-out-of-range' | 'missing-prerequisite' | 'level-too-low' | 'not-enough-points' | 'respec-disabled';
export type SkillCheck = { ok: true } | { ok: false; code: SkillCheckCode; skillId?: string };

/** One point per rank. */
export function skillPointsSpent(skills: SkillAllocation): number {
  let n = 0;
  for (const k of Object.keys(skills)) {
    const r = skills[k];
    if (typeof r === 'number' && Number.isFinite(r) && r > 0) n += r;
  }
  return n;
}
export function skillPointsTotal(level: number, perLevel: number, bonusPoints: number): number {
  // (level-1)*perLevel + bonus
  return Math.max(0, level - 1) * perLevel + bonusPoints;
}
/**
 * Checks `next` (the full desired allocation) in this order: every id is a node of `tree` ('unknown-skill'); 1 <= rank
 * <= maxRank ('rank-out-of-range'); level >= minLevel ('level-too-low'); every `requires` met in `next`
 * ('missing-prerequisite'); spent(next) <= totalPoints ('not-enough-points'); and when any rank of `current` is lowered
 * or removed, `allowRespec` must be true ('respec-disabled') UNLESS `current` is invalid for `tree` or overspent
 * (spent(current) > totalPoints), which always allows a reduction. Pure; iteration order = tree order.
 */
export function validateSkillAllocation(tree: SkillTree, next: SkillAllocation, current: SkillAllocation, ctx: { level: number; totalPoints: number; allowRespec: boolean }): SkillCheck {
  const own = (o: SkillAllocation, k: string): number => (Object.hasOwn(o, k) ? (o[k] as number) : 0);
  const nodes = new Map(tree.nodes.map((n) => [n.id as string, n]));
  const ids = Object.keys(next);
  for (const id of ids) if (!nodes.has(id)) return { ok: false, code: 'unknown-skill', skillId: id };
  for (const n of tree.nodes) {
    const r = own(next, n.id);
    if (Object.hasOwn(next, n.id) && (!Number.isInteger(r) || r < 1 || r > n.maxRank)) return { ok: false, code: 'rank-out-of-range', skillId: n.id };
  }
  for (const n of tree.nodes) if (Object.hasOwn(next, n.id) && ctx.level < n.minLevel) return { ok: false, code: 'level-too-low', skillId: n.id };
  for (const n of tree.nodes) {
    if (!Object.hasOwn(next, n.id)) continue;
    for (const req of n.requires) if (own(next, req.id) < req.rank) return { ok: false, code: 'missing-prerequisite', skillId: n.id };
  }
  if (skillPointsSpent(next) > ctx.totalPoints) return { ok: false, code: 'not-enough-points' };
  if (!ctx.allowRespec) {
    const lowered = Object.keys(current).find((id) => own(next, id) < own(current, id));
    if (lowered !== undefined) {
      const currentInvalid = Object.keys(current).some((id) => {
        const n = nodes.get(id);
        const r = current[id] as number;
        return !n || !Number.isInteger(r) || r < 1 || r > n.maxRank;
      });
      if (!currentInvalid && skillPointsSpent(current) <= ctx.totalPoints) return { ok: false, code: 'respec-disabled', skillId: lowered };
    }
  }
  return { ok: true };
}

// ------------------------------------------------------------------ XP and levels

export interface XpWeights { output: number; input: number; cacheCreation: number; cacheRead: number }
export interface LevelCurve { levelBase: number; levelExponent: number; maxLevel: number }
export type UsageCounters = Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>;

/** Non-finite or negative → 0; clamped to PROGRESSION_LIMITS.maxCounter. */
const clampCounter = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.min(n, PROGRESSION_LIMITS.maxCounter) : 0);
/** floor(output*w.output + input*w.input + cacheCreation*w.cacheCreation + cacheRead*w.cacheRead); counters are clamped to
 *  maxCounter (non-finite/negative count as 0) and the result to maxXp. */
export function xpFromUsage(u: UsageCounters, w: XpWeights): number {
  const c = clampCounter;
  return Math.min(PROGRESSION_LIMITS.maxXp, Math.floor(c(u.outputTokens) * c(w.output) + c(u.inputTokens) * c(w.input) + c(u.cacheCreationTokens) * c(w.cacheCreation) + c(u.cacheReadTokens) * c(w.cacheRead)));
}
/** XP needed to reach `level`: 0 for level <= 1, else ceil(levelBase * (level - 1) ^ levelExponent). */
export function xpForLevel(level: number, c: LevelCurve): number {
  if (!(level > 1)) return 0;
  return Math.ceil(c.levelBase * (level - 1) ** c.levelExponent);
}
/** The largest L in [1, maxLevel] with xpForLevel(L) <= xp (= the plan's floor((xp/levelBase)^(1/exponent)) + 1, capped,
 *  but immune to floating-point edge cases at exact boundaries). */
export function levelForXp(xp: number, c: LevelCurve): number {
  const max = Math.max(1, Math.floor(c.maxLevel));
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  const est = Math.floor((xp / c.levelBase) ** (1 / c.levelExponent)) + 1;
  let l = Number.isFinite(est) ? Math.min(max, Math.max(1, est)) : 1;
  while (l < max && xpForLevel(l + 1, c) <= xp) l++;
  while (l > 1 && xpForLevel(l, c) > xp) l--;
  return l;
}
/** For the XP bar: XP at the start of `level` and of the next level (null at maxLevel). */
export function levelSpan(xp: number, c: LevelCurve): { level: number; levelXp: number; nextLevelXp: number | null } {
  const level = levelForXp(xp, c);
  return { level, levelXp: xpForLevel(level, c), nextLevelXp: level >= Math.max(1, Math.floor(c.maxLevel)) ? null : xpForLevel(level + 1, c) };
}
/**
 * The no-double-count rule (section 2.3): mark' = component-wise max(prev ?? 0, usage); xpDelta = max(0,
 * xpFromUsage(mark') - xpFromUsage(prev ?? 0)) capped at maxXpPerUpdate; stored counters are clamped; changed = mark' !== prev on any counter.
 */
export function advanceUsageMark(prev: UsageCounters | null, usage: UsageCounters, w: XpWeights): { mark: UsageCounters; changed: boolean; xpDelta: number } {
  const c = clampCounter;
  const p = prev ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const mark: UsageCounters = {
    inputTokens: Math.max(c(p.inputTokens), c(usage.inputTokens)),
    outputTokens: Math.max(c(p.outputTokens), c(usage.outputTokens)),
    cacheReadTokens: Math.max(c(p.cacheReadTokens), c(usage.cacheReadTokens)),
    cacheCreationTokens: Math.max(c(p.cacheCreationTokens), c(usage.cacheCreationTokens)),
  };
  // No stored mark yet: the first one always counts as a change so the caller persists it.
  const changed =
    prev === null ||
    mark.inputTokens !== p.inputTokens ||
    mark.outputTokens !== p.outputTokens ||
    mark.cacheReadTokens !== p.cacheReadTokens ||
    mark.cacheCreationTokens !== p.cacheCreationTokens;
  return { mark, changed, xpDelta: Math.min(PROGRESSION_LIMITS.maxXpPerUpdate, Math.max(0, xpFromUsage(mark, w) - xpFromUsage(p, w))) };
}

// ------------------------------------------------------------------ loot

export const LOOT_IDS = [
  'hat-cap', 'hat-police-cap', 'hat-fedora', 'hat-hardhat',
  'prop-mop', 'prop-parcel', 'prop-watering-can', 'prop-clipboard',
  'title-bug-squasher', 'title-red-tape-cutter', 'title-redacted', 'title-unsold', 'title-rival-tamer', 'title-cat-whisperer',
] as const;
export type LootId = (typeof LOOT_IDS)[number];
export const LootIdSchema = z.enum(LOOT_IDS);
export type LootGrant = { kind: 'hat'; hat: LootHat } | { kind: 'prop'; prop: LootProp } | { kind: 'title' };
/** From the id prefix: 'hat-x' → { hat: x }, 'prop-x' → { prop: x }, 'title-*' → title. Test: total over LOOT_IDS and every hat/prop is in LOOT_HATS/LOOT_PROPS. */
export function lootGrant(id: LootId): LootGrant {
  if (id.startsWith('hat-')) return { kind: 'hat', hat: id.slice(4) as LootHat };
  if (id.startsWith('prop-')) return { kind: 'prop', prop: id.slice(5) as LootProp };
  return { kind: 'title' };
}
export type LootTable = readonly { id: LootId; weight: number }[];

export interface EnemyDef {
  kind: BattleNpcKind;
  type: EnemyType;
  base: Stats; // focus ignored
  ai: 'aggressive' | 'tricky' | 'tank';
  moves: readonly string[]; // move ids; index 0 = basic attack
  loot: LootTable;
}

// ------------------------------------------------------------------ hero progress

/** What the DB stores per hero (level, available points and the class are derived on read). */
export interface HeroProgressCore {
  classId: ClassId; // class the skills were allocated for; a role change makes them void (full refund on read)
  xp: number;
  bonusPoints: number;
  skills: SkillAllocation;
  koUntil: number | null;
  wins: number;
  losses: number;
  flees: number;
  loot: readonly LootId[];
  equippedTitle: LootId | null;
  updatedAt: number;
  /** Last skill save (absent/0 = never); migration 13. */
  skillsUpdatedAt?: number;
}

/** Server → client view (REST, snapshot, `hero:progress`). */
export const HeroProgressSchema = z.object({
  heroId: z.string().regex(HERO_ID_RE),
  projectId: z.string().min(1).max(200),
  classId: z.enum(CLASS_IDS),
  xp: z.number().int().min(0),
  level: z.number().int().min(1),
  levelXp: z.number().int().min(0),
  nextLevelXp: z.number().int().min(0).nullable(),
  /** Available (unspent) points; 0 when overspent after a curve change. */
  skillPoints: z.number().int().min(0),
  bonusPoints: z.number().int().min(0),
  /** Only skills of the current class; overspent allocations are kept (the user must respec). */
  skills: z.record(z.string().regex(SKILL_ID_RE), z.number().int().min(1).max(10)),
  overspent: z.boolean(),
  koUntil: z.number().nullable(),
  wins: z.number().int().min(0),
  losses: z.number().int().min(0),
  flees: z.number().int().min(0),
  loot: z.array(LootIdSchema).max(LOOT_IDS.length),
  equippedTitle: LootIdSchema.nullable(),
  updatedAt: z.number(),
  /** Bumped only by a skill save (not by XP, titles or heals); the optimistic-concurrency stamp of `baseSkillsUpdatedAt`. */
  skillsUpdatedAt: z.number().optional(),
});
export type HeroProgress = z.infer<typeof HeroProgressSchema>;

export const isKnockedOut = (p: Pick<HeroProgress, 'koUntil'> | undefined, now: number): boolean => !!p && p.koUntil !== null && p.koUntil > now;

// ------------------------------------------------------------------ REST contract

export const BATTLE_ID_RE = /^b-[a-f0-9]{12}$/;
/** M13 `NpcActor.id` (`<kind>-<seq>`). */
export const ENCOUNTER_ID_RE = /^[a-z0-9-]{1,64}$/;
/** Stable `details.code` of the 409 a skill save gets when the skills changed since the client loaded them. */
export const SKILLS_CONFLICT_CODE = 'skills-conflict';
export const PROGRESSION_LIMITS = {
  maxParty: 4, maxMoves: 8, maxItems: 4, maxLog: 220, maxSkillKeys: 48,
  /** maxLog = 200 (max battle.maxTurns) + 4 (maxParty swaps) + 16 slack. */
  maxStoredBattles: 2000,
  /** Clamps for stored/derived counters and XP (keep every sum an exact safe integer). */
  maxCounter: 1e13,
  maxXp: 1e12,
  maxXpPerUpdate: 5_000_000,
} as const;

/** GET /api/progress */
export const ProgressListQuerySchema = z.strictObject({ projectId: z.string().min(1).max(200).optional() });
/** POST /api/heroes/:id/skills: the FULL desired allocation (allocate and respec are the same call). */
export const SkillAllocationSchema = z.strictObject({
  skills: z
    .record(z.string().regex(SKILL_ID_RE), z.number().int().min(1).max(10))
    .refine((o) => Object.keys(o).length <= PROGRESSION_LIMITS.maxSkillKeys, 'too many skills')
    .transform((o): Record<string, number> => Object.assign(Object.create(null) as Record<string, number>, o)),
  /** Optimistic concurrency: 409 (`details.code` = SKILLS_CONFLICT_CODE) when the stored `skillsUpdatedAt` (0 if never saved) differs. */
  baseSkillsUpdatedAt: z.number().optional(),
  /** @deprecated Accepted for old clients and ignored: `updatedAt` moves on every XP credit, so it cannot guard a skill save. */
  baseUpdatedAt: z.number().optional(),
});
export type SkillAllocationRequest = z.input<typeof SkillAllocationSchema>;
/** POST /api/heroes/:id/title: equip an owned title loot, or null to clear. */
export const TitleEquipSchema = z.strictObject({ title: LootIdSchema.nullable() });
/** POST /api/heroes/:id/heal and POST /api/battles/:id/abandon: no fields. */
export const EmptyBodySchema = z.strictObject({});
/** POST /api/battles */
export const BattleCreateSchema = z.strictObject({
  projectId: z.string().min(1).max(200),
  npcKind: z.enum(BATTLE_NPC_KINDS),
  encounterId: z.string().regex(ENCOUNTER_ID_RE),
  party: z.array(PartyRefSchema).min(1).max(PROGRESSION_LIMITS.maxParty),
});
export type BattleCreate = z.input<typeof BattleCreateSchema>;
/** POST /api/battles/:id/resolve */
export const BattleResolveSchema = z.strictObject({
  log: z.array(PlayerActionSchema).max(PROGRESSION_LIMITS.maxLog),
  /** What the client's engine concluded; a mismatch with the server replay is a 409 (desync), nothing is awarded. */
  expect: z.strictObject({ result: z.enum(BATTLE_RESULTS), turns: z.number().int().min(0).max(10_000) }).optional(),
});
export type BattleResolve = z.input<typeof BattleResolveSchema>;

export const BATTLE_STATUSES = ['open', 'resolved', 'abandoned', 'expired'] as const;
export type BattleStatus = (typeof BATTLE_STATUSES)[number];

export interface BattleStart {
  id: string;
  projectId: string;
  npcKind: BattleNpcKind;
  encounterId: string;
  status: BattleStatus;
  setup: BattleSetup;
  createdAt: number;
  expiresAt: number;
}
export interface HeroAward {
  heroId: string;
  memberIndex: number;
  xpGained: number;
  levelBefore: number;
  levelAfter: number;
  skillPointsGained: number;
  fainted: boolean;
  koUntil: number | null;
}
export interface BattleOutcome {
  battleId: string;
  result: BattleResult;
  turns: number;
  heroes: readonly HeroAward[]; // hero members only; anonymous agents get nothing
  loot: { heroId: string; lootId: LootId } | null;
  resolvedAt: number;
}

export type { PartyRef };
