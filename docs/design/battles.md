# Encounters, battles and hero progression (M14 → v0.8.0)

Status: approved for implementation (threat model W0-S folded in: F1–F15) · Plan: `~/.claude-sessions/profiles/edgar/plans/pasted-content-id-1097-tagconn-features-lucky-milner.md` section "M14"
Scope: 14.1 progression contract + seeded battle engine (shared), 14.2 server `progression` module, 14.3 web encounter
prompt, party picker, battle screen, hero sheet, KO presence, loot cosmetics.

Read first: `docs/design/office-life.md` (M13: NPC director, alerts, audio; section 3.5.6 "M14 hooks"),
`docs/design/living-office.md` (heroes, binding rules, hero editor), `apps/server/src/modules/heroes/**` (module
precedent), `apps/server/src/modules/transcripts/transcripts.service.ts` (where `Agent.usage` is set).

---

## 0. Goals, non-goals, invariants

**Goals**
- Heroes level up from the tokens their bound agents spend: XP = weighted usage deltas (cache reads excluded by default).
- Each hero has a class (from its role), stats, and a 3-branch skill tree the user spends points in (respec allowed).
- An M13 encounter NPC can be challenged: "A wild *Sales Dog* appeared! [Battle] [Ignore]" → party of 1–4 → a
  Pokémon-style turn-based battle on a dedicated Phaser `BattleScene` with a swirl transition.
- Stakes: XP, skill points, cosmetic loot (hats, props, titles), and a soft KO.
- All art and audio code-generated (ADR #22); three themed skins (modern satire / guild fantasy / rift sci-fi) over one
  shared mechanic set (D2 spirit).

**Non-goals (M14)**
- PvP, multiplayer battles, battles on the Multiverse floor (NPCs are off there), trading loot between heroes,
  server-side enforcement of loot ownership on hero appearance edits (see 7), revive items.

**Invariants (every task keeps these)**
1. **Real agent work is never affected.** Battles, KO and loot only change progression rows and cosmetics. Nothing
   touches agents, sessions, runs, hooks or `SeatAllocator`. A KO'd *working* hero is never moved; it only gets a
   bandage icon. An idle/resting KO'd hero only gets a "💫" icon where it already is (idle and resting characters
   already sit in the lounge); no new walking.
2. **Server is authoritative** for XP, level, skill points, loot, KO and the win/loss tally. The battle engine is a
   pure, deterministic, seeded function in `packages/shared` (integer math only, no `Math.random`, no `Date`, no
   `Math.pow` inside the engine). The server picks the seed and builds the full `BattleSetup` (stats, moves, items);
   the client animates the same engine; on resolve the server **replays the action log** against the stored setup and
   only then awards. Resolve is **exactly-once and idempotent** (conditional status update in one `BEGIN IMMEDIATE`
   SQLite transaction; the same log again returns the stored outcome). The loot roll uses a separate server-only
   `lootSeed` that is never sent to clients (F4).
3. **XP is never double-counted per (sessionId, agentId).** For each (sessionId, agentId) the server stores a
   component-wise high-water mark of the cumulative token counters; XP is credited only for the increase of
   `xpFromUsage(mark)`. For the same key, transcript re-parses, server restarts, agent re-adds and debounced repeats
   yield no delta. Known limit (F3, accepted, section 7): a forked/resumed session gets a new key, so if its new
   transcript copies earlier history, the copied part is counted again. Every credit is also clamped
   (`PROGRESSION_LIMITS.maxXpPerUpdate`, `maxXp`, `maxCounter`; F2).
4. **Security parity.** New REST writes use `access: 'admin'` (same as hero edits), strict zod bodies, the existing
   Host/Origin/JSON guards, per-route `bodyLimit`, REST error shape `{ error, statusCode, details? }`, and in-memory
   rate limits (429). No new socket client→server events (reads come with the snapshot and `hero:progress` pushes).
5. **Configurable.** Every user-facing threshold is in `progression.*` / `battle.*` (section 1.4). Internal timings and
   hard caps are named constants (`BATTLE_TIMING`, `PROGRESSION_LIMITS`).
6. **ADR #22 / D2.** Enemy, effect and icon art are code-drawn bitmaps; battle music and SFX are synthesized. Mechanics
   are style-agnostic; only labels, art and copy differ per style.
7. **Hot files.** No task edits `OfficeScene.ts`, `OfficeView.tsx`, `OfficeGame.ts` or `MenuSheet.tsx`; the PM wires
   modules in (section 3.10). `game/sfxBus.ts` and `lib/audio/presets.ts` are owned by the in-flight UI-sound task
   until it lands (see W0w).
8. **Gates.** `progression.enabled` off: no XP credited (marks still advance), no level UI. `battle.enabled` off (or
   `progression.enabled` off): no encounter prompts, battle routes answer 409. Reduced motion: no swirl, shakes,
   lunges, typewriter or bar tweens (short sting + fades only). Canvas renderer: everything works (no shaders).
9. **Bounded storage (F1).** The `battles` table is capped (`PROGRESSION_LIMITS.maxStoredBattles`, `retentionDays`
   ≤ 365, `maxPerHour` ≤ 120), a stored setup is at most 32 KiB, and resolved rows lose their setup/log after 24 h.

---

## 1. Shared contract (`packages/shared`)

Files (all new unless noted):
- `src/progression.ts` (W0a): vocabulary, schemas, pure XP/level/skill math, REST schemas, response types.
- `src/battle/types.ts` (W0a): engine types, `PlayerActionSchema`, `PartyRefSchema`, type chart.
- `src/battle/rng.ts`, `src/battle/engine.ts` (W0c): the engine.
- `src/progressionContent.ts` (W0b): classes, skill trees, moves, items, enemies, loot tables (data).
- `src/battle/setup.ts` (W0b): `statsFor`, setup builder, enemy scaling, outcome, `progressView`.
- `src/heroes.ts` (edit, W0a): loot hat/prop vocabulary + two optional appearance fields.
- `src/domain.ts` (edit, W0a): `OfficeSnapshot.progress?`. `src/socket.ts` (edit, W0a): `hero:progress`.
- `src/settings.ts` (edit, W0s): `progression` and `battle` sections.
- `src/index.ts` (edit, W0a): `export * from './progression.js'; export * from './progressionContent.js';
  export * from './battle/types.js'; export * from './battle/engine.js'; export * from './battle/setup.js';`
  (W0a adds all five lines; W0b/W0c create the files W0a already re-exports — W0a creates empty placeholder modules
  `progressionContent.ts`, `battle/engine.ts`, `battle/setup.ts` containing only `export {};` so the root typecheck stays green.)

Import graph (no runtime cycles): `heroes.ts` ← `battle/types.ts` ← `progression.ts` ← `progressionContent.ts` ←
`battle/setup.ts`; `battle/engine.ts` imports only `battle/types.ts` and `battle/rng.ts`. `battle/types.ts` imports
from `progression.ts` with `import type` only.

### 1.1 `src/heroes.ts` additions (W0a)

Loot cosmetics reuse hats/props that M13 already draws for NPCs (`game/themes/types.ts` `Costume.hat/staff`). They
are **separate optional appearance fields**, so `HERO_HATS`/`HERO_PROPS`, `randomizeAppearance`, `HAT_LABELS` and
stored rows stay unchanged:

```ts
/** M14: hats/props only obtainable as battle loot. When set they override `hat`/`prop`. */
export const LOOT_HATS = ['cap', 'police-cap', 'fedora', 'hardhat'] as const;
export type LootHat = (typeof LOOT_HATS)[number];
export const LOOT_PROPS = ['mop', 'parcel', 'watering-can', 'clipboard'] as const;
export type LootProp = (typeof LOOT_PROPS)[number];
```
Inside `HeroAppearanceSchema` (append; optional so every stored row and every existing client stays valid):
```ts
  /** M14 loot hat; null/omitted = use `hat`. Ownership is checked by the UI (docs/design/battles.md 7). */
  lootHat: z.enum(LOOT_HATS).nullable().optional(),
  /** M14 loot prop; null/omitted = use `prop`. */
  lootProp: z.enum(LOOT_PROPS).nullable().optional(),
```
`generateHeroAppearance` does not set them. `HeroStyleOverrideSchema` picks them up through `.partial().shape`.

### 1.2 `src/battle/types.ts` (W0a, verbatim)

```ts
import { z } from 'zod';
import { HERO_ID_RE } from '../heroes.js';
import type { BattleNpcKind, BattleType, ClassId, EnemyType, HeroType, ItemDef, MajorStatus, MoveDef, Stats } from '../progression.js';

/** Bump on ANY change to engine rules, draw order or the setup shape. Stored setups of another version are not replayable. */
export const ENGINE_VERSION = 1;

export const BATTLE_RESULTS = ['won', 'lost', 'fled', 'timeout'] as const;
export type BattleResult = (typeof BATTLE_RESULTS)[number];

export const PartyRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('hero'), heroId: z.string().regex(HERO_ID_RE) }),
  /** Anonymous subagent (no hero): fights with a temporary level from its own usage; nothing is persisted for it. */
  z.strictObject({ kind: z.literal('agent'), agentId: z.string().min(1).max(200) }),
]);
export type PartyRef = z.infer<typeof PartyRefSchema>;

/** Indices refer to the acting combatant's `moves`, the setup's `items`, and party member slots. */
export const PlayerActionSchema = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('move'), move: z.number().int().min(0).max(7) }),
  z.strictObject({ t: z.literal('item'), item: z.number().int().min(0).max(3), target: z.number().int().min(0).max(3).optional() }),
  z.strictObject({ t: z.literal('swap'), to: z.number().int().min(0).max(3) }),
  z.strictObject({ t: z.literal('run') }),
]);
export type PlayerAction = z.infer<typeof PlayerActionSchema>;

export interface CombatMods {
  critPct: number; // added to the 6% base
  focusRegen: number; // added to the base 2 per turn
  statusResistPct: number;
  healBoostPct: number;
  typeBoostPct: number; // extra damage % on same-type (STAB) moves
}

export interface CombatantSetup {
  ref: PartyRef | { kind: 'enemy'; npcKind: BattleNpcKind };
  /** Hero name (sanitized, <= 40) or the npc kind; display only (the web themes enemy names). */
  name: string;
  classId: ClassId | null; // null for enemies
  type: HeroType | EnemyType;
  level: number;
  stats: Stats; // hp = max HP, focus = max FOCUS
  /** Full move definitions (copied from content when the battle is created). Index 0 = the basic attack. <= 8. */
  moves: readonly MoveDef[];
  mods: CombatMods;
  ai: 'aggressive' | 'tricky' | 'tank' | null; // enemies only
  temporary: boolean; // anonymous agent with a temporary level
}

export interface BattleSetup {
  engineVersion: number;
  seed: number; // uint32, server-chosen
  party: readonly CombatantSetup[]; // 1..4, index 0 starts active
  enemy: CombatantSetup;
  items: readonly { def: ItemDef; count: number }[]; // <= 4, fixed order coffee, energy-drink, rubber-duck, pizza; count 0 entries omitted
  maxTurns: number;
}

export interface CombatantState {
  hp: number;
  focus: number;
  status: MajorStatus | null;
  statusTurns: number;
  buffTurns: number; // 'buffed': ATK x1.5
  shieldTurns: number; // 'shielded': incoming damage x0.5
  fainted: boolean;
}

export type BattlePhase = 'choose' | 'forced-swap' | 'ended';

/** Plain JSON (no classes, no Maps): cloneable, serializable, comparable with toEqual. */
export interface BattleState {
  engineVersion: number;
  rng: number; // mulberry32 state (uint32)
  turn: number; // 1-based
  phase: BattlePhase;
  active: number;
  party: CombatantState[];
  enemy: CombatantState;
  items: number[]; // remaining counts, same order as setup.items
  runAttempts: number;
  actions: number; // actions applied so far
  result: BattleResult | null;
}

export type Side = { side: 'party'; index: number } | { side: 'enemy' };
export type Effectiveness = 'super' | 'normal' | 'weak';

export type BattleEvent =
  | { k: 'start' }
  | { k: 'turn'; turn: number }
  | { k: 'use'; by: Side; move: number }
  | { k: 'item'; item: number; target: number }
  | { k: 'damage'; target: Side; amount: number; hp: number; eff: Effectiveness; crit: boolean; selfHit: boolean }
  | { k: 'miss'; by: Side }
  | { k: 'heal'; target: Side; amount: number; hp: number }
  | { k: 'focus'; target: Side; amount: number; focus: number }
  | { k: 'status'; target: Side; status: MajorStatus | 'buffed' | 'shielded'; on: boolean }
  | { k: 'resisted'; target: Side; status: MajorStatus }
  | { k: 'skip'; by: Side; reason: 'stunned' }
  | { k: 'confused'; by: Side } // merge-conflict: the next damage event is a self-hit
  | { k: 'swap'; from: number; to: number; forced: boolean }
  | { k: 'faint'; target: Side }
  | { k: 'run'; ok: boolean }
  | { k: 'end'; result: BattleResult };

export type BattleActionError =
  | 'ended' | 'version' | 'swap-required' | 'bad-move' | 'no-focus' | 'bad-item' | 'no-item' | 'bad-target' | 'bad-swap';
export type ApplyResult = { ok: true; state: BattleState; events: BattleEvent[] } | { ok: false; error: BattleActionError };
export type ReplayResult =
  | { ok: true; state: BattleState; events: BattleEvent[]; result: BattleResult | null; turns: number }
  | { ok: false; error: BattleActionError; at: number };

/** Per-mille multipliers; missing pairs = 1000. Attacker type → defender type. Section 4.5. */
export const TYPE_CHART: Readonly<Partial<Record<BattleType, Partial<Record<BattleType, 2000 | 500>>>>> = {
  test: { bug: 2000, rival: 500 },
  build: { bug: 500, bureaucrat: 2000 },
  secure: { bureaucrat: 2000, feral: 500 },
  insight: { bureaucrat: 500, salesy: 2000 },
  lead: { salesy: 500, feral: 2000 },
  design: { rival: 2000 },
  review: { rival: 2000 },
  grit: { feral: 2000 },
  bug: { build: 2000, test: 500 },
  bureaucrat: { lead: 2000, secure: 500 },
  salesy: { design: 2000, insight: 500 },
  rival: { build: 2000, review: 500 },
  feral: { review: 2000, lead: 500 },
};
export function typeEffect(attacker: BattleType, defender: BattleType): 2000 | 1000 | 500 {
  return TYPE_CHART[attacker]?.[defender] ?? 1000;
}
```

### 1.3 `src/progression.ts` (W0a, verbatim; bodies are the developer's, the rules are given)

```ts
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
export function classForRole(role: string): ClassId;

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
export function skillPointsSpent(skills: SkillAllocation): number;
export function skillPointsTotal(level: number, perLevel: number, bonusPoints: number): number; // (level-1)*perLevel + bonus
/**
 * Checks `next` (the full desired allocation) in this order: every id is a node of `tree` ('unknown-skill'); 1 <= rank
 * <= maxRank ('rank-out-of-range'); level >= minLevel ('level-too-low'); every `requires` met in `next`
 * ('missing-prerequisite'); spent(next) <= totalPoints ('not-enough-points'); and when any rank of `current` is lowered
 * or removed, `allowRespec` must be true ('respec-disabled') UNLESS `current` is invalid for `tree` or overspent
 * (spent(current) > totalPoints), which always allows a reduction. Pure; iteration order = tree order.
 * Allocation keys are looked up with `Object.hasOwn` / a `Map` built from `tree.nodes`, never `obj[key]` on a
 * prototype-bearing object (F14), so `__proto__`/`constructor`/`toString` are 'unknown-skill'.
 */
export function validateSkillAllocation(tree: SkillTree, next: SkillAllocation, current: SkillAllocation, ctx: { level: number; totalPoints: number; allowRespec: boolean }): SkillCheck;

// ------------------------------------------------------------------ XP and levels

export interface XpWeights { output: number; input: number; cacheCreation: number; cacheRead: number }
export interface LevelCurve { levelBase: number; levelExponent: number; maxLevel: number }
export type UsageCounters = Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>;

/** floor(output*w.output + input*w.input + cacheCreation*w.cacheCreation + cacheRead*w.cacheRead); counters are clamped to
 *  PROGRESSION_LIMITS.maxCounter (non-finite/negative count as 0) and the result to maxXp (F2). */
export function xpFromUsage(u: UsageCounters, w: XpWeights): number;
/** XP needed to reach `level`: 0 for level <= 1, else ceil(levelBase * (level - 1) ^ levelExponent). */
export function xpForLevel(level: number, c: LevelCurve): number;
/** The largest L in [1, maxLevel] with xpForLevel(L) <= xp (= the plan's floor((xp/levelBase)^(1/exponent)) + 1, capped,
 *  but immune to floating-point edge cases at exact boundaries). */
export function levelForXp(xp: number, c: LevelCurve): number;
/** For the XP bar: XP at the start of `level` and of the next level (null at maxLevel). */
export function levelSpan(xp: number, c: LevelCurve): { level: number; levelXp: number; nextLevelXp: number | null };
/**
 * The no-double-count rule (section 2.3): mark' = component-wise max(prev ?? 0, usage), every counter clamped to
 * maxCounter; xpDelta = max(0, xpFromUsage(mark') - xpFromUsage(prev ?? 0)) capped at maxXpPerUpdate (the over-cap
 * part is dropped, never re-credited, because the mark still advances fully); changed = prev === null or mark' !== prev
 * on any counter.
 */
export function advanceUsageMark(prev: UsageCounters | null, usage: UsageCounters, w: XpWeights): { mark: UsageCounters; changed: boolean; xpDelta: number };

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
export function lootGrant(id: LootId): LootGrant;
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
});
export type HeroProgress = z.infer<typeof HeroProgressSchema>;

export const isKnockedOut = (p: Pick<HeroProgress, 'koUntil'> | undefined, now: number): boolean => !!p && p.koUntil !== null && p.koUntil > now;

// ------------------------------------------------------------------ REST contract

export const BATTLE_ID_RE = /^b-[a-f0-9]{12}$/;
/** M13 `NpcActor.id` (`<kind>-<seq>`). */
export const ENCOUNTER_ID_RE = /^[a-z0-9-]{1,64}$/;
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
    .refine((o) => Object.keys(o).length <= PROGRESSION_LIMITS.maxSkillKeys, 'too many skills'),
  /** Optimistic concurrency: 409 when the stored progress `updatedAt` differs. */
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

/** Never carries the server-only `lootSeed` (F4). */
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
```

### 1.4 Settings (`src/settings.ts`, W0s, verbatim)

Top-level sections after `heroes` (leaf `.default()`, section objects `.prefault({})`, no `.default()` on objects):

```ts
  /** M14: hero levels from tokens spent (docs/design/battles.md). */
  progression: z
    .object({
      enabled: z.boolean().default(true),
      /** XP per token kind. Cache reads are 0 by default so long sessions don't inflate XP. */
      xpWeights: z
        .object({
          output: z.number().min(0).max(10).default(1),
          input: z.number().min(0).max(10).default(0.2),
          cacheCreation: z.number().min(0).max(10).default(0.1),
          cacheRead: z.number().min(0).max(10).default(0),
        })
        .prefault({}),
      /** XP for level L = levelBase * (L-1)^levelExponent. */
      levelBase: z.number().min(10).max(10_000_000).default(1500),
      levelExponent: z.number().min(1).max(4).default(2),
      maxLevel: z.number().int().min(2).max(100).default(50),
      skillPointsPerLevel: z.number().int().min(0).max(5).default(1),
      allowRespec: z.boolean().default(true),
      /** Anonymous subagents may join a party with a temporary level from their own usage. */
      anonymousInBattle: z.boolean().default(true),
    })
    .prefault({}),
  /** M14: turn-based battles against encounter NPCs. Cosmetic stakes only. */
  battle: z
    .object({
      enabled: z.boolean().default(true),
      /** Chance that an encounter NPC offers a battle. */
      offerChance: z.number().min(0).max(1).default(0.5),
      /** Seconds the "Battle / Ignore" prompt waits before it counts as Ignore. */
      autoIgnoreSec: z.number().min(5).max(300).default(20),
      maxParty: z.number().int().min(1).max(4).default(4),
      /** Minutes a knocked-out hero rests (0 = no KO). */
      koMinutes: z.number().min(0).max(240).default(5),
      /** Enemy level = party average level x difficulty (+ a small seeded spread). */
      difficulty: z.number().min(0.5).max(2).default(1),
      music: z.boolean().default(true),
      /** Win XP = levelBase x enemy level x xpScale (about a quarter level at 0.5). */
      xpScale: z.number().min(0).max(10).default(0.5),
      /** A bonus skill point every N wins; 0 = never. */
      skillPointEveryWins: z.number().int().min(0).max(100).default(3),
      lootChance: z.number().min(0).max(1).default(0.35),
      /** Turns before the enemy loses interest (result 'timeout', no stakes). */
      maxTurns: z.number().int().min(10).max(200).default(60),
      /** Battles that may be started per hour (server rate limit). */
      maxPerHour: z.number().int().min(1).max(120).default(30),
      /** Minutes an unresolved battle stays open before it expires. */
      openTtlMin: z.number().int().min(1).max(240).default(30),
      /** Days resolved/abandoned battles are kept. */
      retentionDays: z.number().int().min(1).max(365).default(30),
      /** Consumables each hero party brings to every battle. */
      items: z
        .object({
          coffee: z.number().int().min(0).max(9).default(2),
          energyDrink: z.number().int().min(0).max(9).default(1),
          rubberDuck: z.number().int().min(0).max(9).default(1),
          pizza: z.number().int().min(0).max(9).default(0),
        })
        .prefault({}),
    })
    .prefault({}),
```
- `RESTART_REQUIRED_SETTINGS`, `GUI_IMMUTABLE_SETTINGS`, `WHOLESALE_REPLACE_SETTINGS`: unchanged. Rationale: everything
  is cosmetic, and the rate limits and storage bounds have hard upper bounds in the schema (`maxPerHour` ≤ 120,
  `retentionDays` ≤ 365; F1) plus the `PROGRESSION_LIMITS.maxStoredBattles` row cap. Auth parity (F12): the battle,
  skill, title and heal *writes* are `admin`; the `progression`/`battle` *settings* themselves follow `auth.protect`
  like every other settings section (a cosmetic difference, accepted).
- `config/office.yaml`: commented example blocks for both sections.
- `apps/web/src/features/settings/meta.ts`: `KEY_HINTS` for every leaf (text = the comments above; leaves without a
  comment: `progression.enabled` "Credit XP from token usage to the hero bound to an agent.", `xpWeights.*` "XP per
  <kind> token.", `maxLevel`, `skillPointsPerLevel`, `allowRespec`, `battle.enabled`, `maxParty`, `music`,
  `lootChance`, `items.*` "<Item> per battle."); `NUMBER_STEP` 0.05 for `progression.xpWeights.*`,
  `battle.offerChance`, `battle.lootChance`, `battle.difficulty`, `battle.xpScale`; 0.1 for `progression.levelExponent`.
  `meta.test.ts`: extend `nestedLeafPaths` and the numeric-bounds test with both sections.

### 1.5 Socket and snapshot (W0a)

- `socket.ts` `ServerToClientEvents`: `'hero:progress': (p: HeroProgress) => void;` (broadcast like `hero:upsert`:
  `rooms.all` + the hero's project room). `p.projectId` comes from the `heroes` join in `view()`, never from a cached
  value, and nothing is emitted when `view()` is undefined (hero gone). No client→server events.
- `domain.ts` `OfficeSnapshot`: `/** M14: stored progress of the subscribed floor(s)' heroes (heroes without a row are
  level 1). Optional for pre-M14 servers/fixtures. */ progress?: HeroProgress[];`
- On `hero:remove` clients drop that hero's progress (no separate event).

### 1.6 Engine API (`src/battle/engine.ts`, W0c) and RNG (`src/battle/rng.ts`)

```ts
// rng.ts: mulberry32 as a pure step on a uint32 state (same constants as heroes.ts mulberry32).
export function rngNext(state: number): { value: number; state: number }; // value uint32
export function seedState(seed: number, salt: number): number; // (seed ^ salt) >>> 0, then one rngNext

// engine.ts
export function createBattle(setup: BattleSetup): BattleState; // full HP/focus, active 0, rng = seedState(seed, 0x9e3779b9), turn 1
export function legalActions(setup: BattleSetup, s: BattleState): PlayerAction[]; // UI menus + property tests
export function applyAction(setup: BattleSetup, s: BattleState, a: PlayerAction): ApplyResult; // never mutates `s`
export function replay(setup: BattleSetup, log: readonly PlayerAction[]): ReplayResult; // stops at the first error; extra actions after 'ended' = error 'ended'
/** UI hint without rng: damage range of the active hero's move vs the enemy now. */
export function damagePreview(setup: BattleSetup, s: BattleState, move: number): { min: number; max: number; eff: Effectiveness } | null;
```
The plan's `createBattle(seed, party, enemy)` became `createBattle(setup)`: the setup carries the seed, party and enemy
plus the copied move/item definitions, so a content change between create and resolve can never change a replay.

**Rules (integer math; every multiplication by a per-mille factor is `Math.floor(x * f / 1000)`):**

1. `applyAction` in phase `ended` → `'ended'`; `setup.engineVersion !== ENGINE_VERSION` → `'version'`.
2. Phase `forced-swap` (active hero fainted, others alive): only `swap` to a living member is legal (else
   `'swap-required'` / `'bad-swap'`); emits `swap {forced: true}`; no enemy action, no turn advance; phase → `choose`.
3. Phase `choose`, validation: `move` index < moves.length (`'bad-move'`), focus >= cost (`'no-focus'`); `item` index <
   items.length (`'bad-item'`), count > 0 (`'no-item'`), target a living member, default = active (`'bad-target'`);
   `swap` to a living member other than active (`'bad-swap'`); `run` always legal.
4. **Draw order** (fixed; documented in the engine.ts header; any change bumps `ENGINE_VERSION` and the golden test):
   a. Enemy intent (only if the enemy is not stunned): draw `r1` (category) and `r2` (move within category), section 4.6.
   b. Order: `swap`/`item`/`run` always go first. For two moves: higher `priority` first, then higher SPD
      (effective SPD = stat), tie → draw `r3`, even = party first.
   c. Each actor in order (skip it if it fainted this turn): stunned → `skip`, clear the status, no draws.
      merge-conflict → draw: `< 33` (of `% 100`) = `confused` + self-hit (power 30, `neutral`, no crit, spread 100,
      no draw) and the action is lost. Otherwise run the action.
   d. A move: accuracy < 100 → draw, miss if `% 100 >= accuracy`. Per hit: crit draw (`% 100 < 6 + critPct +
      critBonusPct`), spread draw (`85 + % 16`). After the last hit, if the move has `status` and the target has no major
      status: draw `% 100 < chancePct`, then, if the target has `statusResistPct > 0`, draw `% 100 < statusResistPct`
      → `resisted`; duration draw only if turns[0] < turns[1]. Then `self` (no draw), heals, cures.
   e. Run: `chance = clamp(40 + (heroSpd - enemySpd) + 15 * runAttempts, 10, 95)`, draw `% 100 < chance` → `run
      {ok}`; success ends with `fled` (the enemy does not act); failure increments `runAttempts`.
5. **Damage** (attacker level L, power P, attack A (x1.5 while `buffed`), defense D):
   `base = floor(floor(floor(2 * L / 5 + 2) * P * A / D) / 50) + 2`, then in order: STAB 1250 if move.type ===
   attacker.type (plus `typeBoostPct * 10` per-mille), type effect `typeEffect(move.type, defender.type)`, crit 1500,
   spread (85..100 %), shield 500 if the defender is `shielded`. Minimum 1. `neutral` moves get no STAB and effect 1000.
6. **Heal** `floor(maxHp * healPct * (100 + healBoostPct) / 10000)`, capped at max HP; `party` heals every living member.
   Items: coffee heal 40 %, energy-drink focus 50 %, rubber-duck cure, pizza heal-party 25 % (no heal boost on items).
7. **End of turn**: burnout ticks for the active hero then the enemy (`max(1, floor(maxHp / 12))`, may faint);
   decrement `statusTurns` (status clears at 0, `status {on:false}`), `buffTurns`, `shieldTurns`; active hero regains
   `2 + focusRegen` focus (capped); `turn++`; `turn > maxTurns` → `end timeout`.
8. **Faint**: enemy HP 0 → `faint`, `end won` immediately. Active hero HP 0 → `faint`, `fainted = true`, buff/shield
   cleared; any living member → phase `forced-swap`; none → `end lost`. Major status persists through swaps;
   buff/shield are cleared on swap-out.
9. Every applied action increments `actions`; `turns` in `ReplayResult` = `state.turn - 1` when ended.

#### 1.6.1 Engine rulings (W0c, accepted by the PM)
1. A battle that ends mid-turn still advances `turn`; `turns = state.turn - 1`; a timeout gives exactly `maxTurns`.
2. The timeout check runs before the forced-swap phase (a battle may end `timeout` with the active hero just fainted).
3. Stun is cleared by the skip it causes (exactly one lost action); only burnout and merge-conflict tick down, and only
   for the active hero and the enemy; benched heroes keep their status.
4. A stunned or merge-conflicted actor loses any action type (swap, item and run included).
5. Enemy intent draws `r1`, `r2` at the start of every `choose` action, even when the player runs.
6. Attack category: `r2 % 100 < 60` picks the highest `power × hits × typeEffect`, else `attackList[floor(r2/100) % n]`;
   status/self categories pick `list[r2 % n]`.
7. Enemy self-heal condition: `hp * 100 <= 60 * maxHp`.
8. Events: `start` on the first action only; `turn` at the start of every `choose`; `focus` uses a negative amount for
   focus spent; heal events carry the HP actually gained.
9. `legalActions` lists an item without a target for the active hero plus an explicit target per other living member
   (except `heal-party`); in `forced-swap` only swaps.
10. `damagePreview`: per-hit damage × `hits`, no crit; `min` spread 85, `max` spread 100.
11. `rngNext`/`seedState` are re-exported from `battle/engine.ts` (the package index exports the engine, not `rng.ts`).
12. Loot draw order in `computeOutcome` (W0b): chance roll `% 1000 < round(lootChance*1000)`, then the recipient among
   living heroes (all heroes if everyone fainted), then the weighted pick over the enemy table restricted to unowned
   loot. Changing it changes which loot a stored `lootSeed` yields.

### 1.7 Content (`src/progressionContent.ts`, W0b) and setup (`src/battle/setup.ts`, W0b)

```ts
// progressionContent.ts (data only; numbers in section 4)
export const CLASS_BASE: Readonly<Record<ClassId, Stats>>;
export const SKILL_TREES: Readonly<Record<ClassId, SkillTree>>; // built from SKILL_TEMPLATE + CLASS_MOVES
export const MOVES: Readonly<Record<string, MoveDef>>; // hero + enemy moves
export const BASIC_MOVE: Readonly<Record<ClassId, string>>;
export const ITEMS: Readonly<Record<ItemId, ItemDef>>;
export const ENEMIES: Readonly<Record<BattleNpcKind, EnemyDef>>;

// battle/setup.ts
export function statsFor(classId: ClassId, level: number, skills: SkillAllocation): Stats; // section 4.2, stat passives applied
export function combatModsFor(classId: ClassId, skills: SkillAllocation): CombatMods;
export function movesFor(classId: ClassId, skills: SkillAllocation): MoveDef[]; // basic + unlocked moves in tree order, <= 8
export function skillsForClass(classId: ClassId, skills: SkillAllocation): SkillAllocation; // drops other classes' ids
export function enemyHpPct(partySize: number): number; // 150 + 40 * (n - 1)
export function enemyLevelFor(avgLevel: number, difficulty: number, seed: number, maxLevel: number): number;
export interface PartyMemberInput { ref: PartyRef; name: string; role: string; xp: number; skills: SkillAllocation; temporary: boolean }
export interface BuildSetupInput { seed: number; npcKind: BattleNpcKind; party: readonly PartyMemberInput[]; curve: LevelCurve; difficulty: number; items: ItemCounts; maxTurns: number }
export function buildBattleSetup(i: BuildSetupInput): BattleSetup;
export function battleXp(enemyLevel: number, levelBase: number, xpScale: number, fainted: boolean): number; // round(levelBase*L*xpScale) (half when fainted)
export interface OutcomeConfig { curve: LevelCurve; skillPointsPerLevel: number; xpScale: number; koMinutes: number; skillPointEveryWins: number; lootChance: number }
export interface OutcomeInput {
  setup: BattleSetup; final: BattleState; result: BattleResult; turns: number;
  /** Server-only uint32 (F4): stored on the battle row, never in `BattleSetup`, `BattleStart` or GET responses. */
  lootSeed: number;
  heroes: readonly { heroId: string; memberIndex: number; core: HeroProgressCore }[];
  cfg: OutcomeConfig; now: number;
}
export function computeOutcome(i: OutcomeInput): { awards: HeroAward[]; loot: { heroId: string; lootId: LootId } | null; next: Record<string, HeroProgressCore> };
export function emptyCore(role: string, now: number): HeroProgressCore;
export function progressView(heroId: string, projectId: string, role: string, core: HeroProgressCore, cfg: { curve: LevelCurve; skillPointsPerLevel: number }): HeroProgress;
```
`computeOutcome` rules (section 4.7). Its loot stream is `seedState(lootSeed, 0x27d4eb2f)` (F4): it never depends on
draws inside the battle, and it cannot be predicted from the public `setup.seed` and the turns, so a client cannot
pick a log to choose its loot. Each hero's new XP is clamped like crediting (F2): `xp = Math.min(maxXp, core.xp +
Math.min(xpGained, maxXpPerUpdate))`. `next` and every record it returns are null-prototype objects.
`buildBattleSetup` (F13): for `avgPartyLevel`, a temporary (anonymous) member's level counts at most as the highest
hero level in the party input (members of the same floor), or at its own level when the party has no hero.
`progressView`: `classId = classForRole(role)`; if it differs from `core.classId`, skills = `{}` (full refund);
otherwise `skillsForClass`; `skillPoints = max(0, total - spent)`, `overspent = spent > total`;
`level/levelXp/nextLevelXp` from `levelSpan`.
`skillsForClass` and `combatModsFor` iterate the tree's nodes and read the allocation with `Object.hasOwn` (or a `Map`),
never `skills[key]` on an arbitrary key, and return null-prototype records (F14).

---

## 2. Server module `apps/server/src/modules/progression/`

### 2.1 Files

| file | owner | content |
|---|---|---|
| `progression.tables.ts` | S1 | Drizzle tables `heroProgress`, `usageMarks`, `battles` |
| `progression.repository.ts` | S1 | progress + marks CRUD, views, transaction helpers |
| `battles.repository.ts` | S1 | battles CRUD, conditional status update, prune, strip, row cap |
| `progression.schema.ts` | S1 | `BattleParamsSchema`, `SlidingWindowLimiter`, `WRITE_LIMIT`, `BODY_LIMIT`, `MAX_SETUP_BYTES`, `RESOLVED_KEEP_MS`, `StoredCoreSchema` |
| `index.ts` | S1 | fastify-plugin, DI, bus wiring, routes |
| `progression.service.ts` (+ `__tests__/progression.test.ts`) | S1 stub → S2 | XP crediting, skills, title, heal, reads |
| `progression.routes.ts` | S1 stub → S2 | progress routes |
| `battles.service.ts` (+ `__tests__/battles.test.ts`) | S1 stub → S3 | create, resolve, abandon, get |
| `battles.routes.ts` | S1 stub → S3 | battle routes |
| `progression.socket.ts` | none | not needed: the bridge lives in `core/realtime/index.ts` like `hero:upsert` |

Core edits (S1): `core/db/migrations.ts` (migration 12), `core/event-bus/event-bus.ts` (`'progress.upserted':
HeroProgress`), `core/realtime/index.ts` (`bus.on('progress.upserted', (p) => toProject(p.projectId).emit('hero:progress', p))`;
`toProject` reaches `rooms.all` + the project room, so a socket subscribed only to project B never sees project A's
progress), `modules/snapshot/snapshot.service.ts` + `snapshot/index.ts` (`progress: d.progressionRepository.listViews(pid,
settings)`, dependency `'progression'`), `app.ts` (`await app.register(progressionModule)` right after
`transcriptsModule`).

### 2.2 Tables and migration 12

```sql
/* 12: M14 hero progression, usage high-water marks, battles. Tables in modules/progression/progression.tables.ts. */
CREATE TABLE IF NOT EXISTS hero_progress (
  hero_id TEXT PRIMARY KEY, class_id TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, bonus_points INTEGER NOT NULL DEFAULT 0,
  skills TEXT NOT NULL, ko_until INTEGER, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
  flees INTEGER NOT NULL DEFAULT 0, loot TEXT NOT NULL, equipped_title TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_marks (
  session_id TEXT NOT NULL, agent_id TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);
CREATE TABLE IF NOT EXISTS battles (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL, npc_kind TEXT NOT NULL, encounter_id TEXT NOT NULL,
  setup TEXT NOT NULL, loot_seed INTEGER NOT NULL, party_hero_ids TEXT NOT NULL, log TEXT, log_hash TEXT, outcome TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS battles_project_status_idx ON battles (project_id, status);
CREATE INDEX IF NOT EXISTS battles_created_idx ON battles (created_at);
CREATE INDEX IF NOT EXISTS battles_status_expires_idx ON battles (status, expires_at);
```
Migration 12 is additive only (new tables and indexes; no existing table changes).
- `hero_progress` has no `project_id`: listing joins `heroes`, so a hero that moved floors (M12 merge) needs no update,
  and rows of deleted heroes never surface. `pruneOrphans()` (`DELETE FROM hero_progress WHERE hero_id NOT IN
  (SELECT id FROM heroes)`) runs at boot; it covers heroes dropped by `merge-projects.ts`, which deletes with raw SQL
  and emits no bus event. No edit to `merge-projects.ts` is needed. Between boots, `upsertCore` refuses to create a row
  for a hero that no longer exists (F5), so a merge-deleted hero never gets a new orphan row.
- `usage_marks` is never pruned in M14 (one ~100-byte row per agent ever seen). A resumed session can re-read an old
  transcript at any time, so a pruned mark would double-count. Section 7 has the trade-off.
- `battles.project_id` is not repointed on merges. It only scopes "one open battle per floor"; resolve works by id.
  `abandonOpenWithHeroes` (below) keeps "one open battle per hero" true across merges (F6).
- `battles.loot_seed` (F4) is a server-only uint32; it is never part of `setup` or any response.
- `battles.expires_at` (F9) is fixed at create (`createdAt + openTtlMin * 60_000`); lowering `openTtlMin` later never
  expires an open battle early, raising it never extends one.
- **Row lifecycle (F1).** A resolved row keeps `setup` and `log` for `RESOLVED_KEEP_MS` (24 h) so an identical repeat
  can be answered with the full row. After that, housekeeping strips them (`setup = '{}'`, `log = NULL`), keeping
  `outcome` and `log_hash`; a later repeat is answered by hash only. Abandoned/expired rows are stripped the same way.
  Rows older than `retentionDays` are deleted, and then only the newest `PROGRESSION_LIMITS.maxStoredBattles` non-open
  rows are kept.

Repository API (S1):
```ts
/** F14: stored JSON is parsed through zod (skill keys match SKILL_ID_RE, ranks 1..10, <= maxSkillKeys; loot = LootIdSchema,
 *  deduped, <= LOOT_IDS.length) into null-prototype records. */
export type CoreRead = { kind: 'missing' } | { kind: 'corrupt' } | { kind: 'ok'; core: HeroProgressCore };
export class ProgressionRepository {
  constructor(deps: Deps<'db' | 'sqlite' | 'logger'>);
  /** 'missing' = no row; 'corrupt' = a row whose JSON/zod parse fails (logged as a warning; the row is never overwritten).
   *  Skill keys failing SKILL_ID_RE (e.g. a stored `__proto__`) are dropped on read, not treated as corrupt. */
  getCore(heroId: string): CoreRead;
  /** INSERT ... SELECT ... WHERE EXISTS (SELECT 1 FROM heroes WHERE id = ?) ON CONFLICT DO UPDATE; false when the hero is unknown (F5). */
  upsertCore(heroId: string, core: HeroProgressCore): boolean;
  delete(heroId: string): boolean;
  pruneOrphans(): number;
  /** JOIN heroes; heroes WITHOUT a row are not listed (the client shows level 1). Corrupt rows are skipped. */
  listViews(projectId: string | undefined, s: Settings): HeroProgress[];
  /** The row's view, or the default (level 1) view when the hero exists without a row; undefined when the hero is unknown.
   *  projectId comes from the heroes join. */
  view(heroId: string, s: Settings): HeroProgress | undefined;
  getMark(sessionId: string, agentId: string): UsageCounters | undefined;
  upsertMark(sessionId: string, agentId: string, m: UsageCounters, now: number): void;
  tx<T>(fn: () => T): T; // sqlite.transaction(fn)()
  /** BEGIN IMMEDIATE (F7): sqlite.transaction(fn).immediate(). Used by battle create and resolve. */
  txImmediate<T>(fn: () => T): T;
}
/** `setup` is null on a stripped row (stored '{}'); `log` is null when absent or stripped. */
export interface BattleRow { id: string; projectId: string; status: BattleStatus; npcKind: BattleNpcKind; encounterId: string; setup: BattleSetup | null; lootSeed: number; partyHeroIds: string[]; log: PlayerAction[] | null; logHash: string | null; outcome: BattleOutcome | null; createdAt: number; expiresAt: number; resolvedAt: number | null }
export class BattlesRepository {
  /** Throws HttpError(500) (and logs) when JSON.stringify(row.setup) exceeds MAX_SETUP_BYTES (32 KiB); throws a
   *  distinguishable 'id-collision' error on a PRIMARY KEY conflict (the service retries once with a new id). */
  insert(row: BattleRow): void;
  get(id: string): BattleRow | undefined;
  /** UPDATE ... SET status = to, <patch> WHERE id = ? AND status = from; true when exactly one row changed. */
  transition(id: string, from: BattleStatus, to: BattleStatus, patch: Partial<Pick<BattleRow, 'log' | 'logHash' | 'outcome' | 'resolvedAt'>>): boolean;
  /** Open battles of this floor → abandoned. */
  abandonOpen(projectId: string, now: number): number;
  /** Open battles (any floor) whose party_hero_ids contain any of these heroes → abandoned (F6). */
  abandonOpenWithHeroes(heroIds: readonly string[], now: number): number;
  /** UPDATE ... SET status = 'expired' WHERE status = 'open' AND expires_at < ? (F9). */
  expireOpenBefore(now: number): number;
  /** Non-open rows created before ts: setup = '{}', log = NULL; outcome and log_hash kept (F1). */
  stripBefore(ts: number): number;
  prune(beforeTs: number): number; // non-open rows only
  /** Deletes non-open rows beyond the newest `keep` by created_at; returns the count (F1). */
  pruneExcess(keep: number): number;
}
```
`progression.schema.ts`:
```ts
export const BattleParamsSchema = z.object({ id: z.string().regex(BATTLE_ID_RE) });
export const WRITE_LIMIT = { max: 30, windowMs: 60_000 } as const; // per route family, in memory, per app instance
/** F10: per-route request body limits (bytes). */
export const BODY_LIMIT = { default: 16_384, resolve: 32_768 } as const;
/** F1: largest serialized BattleSetup the repository stores. */
export const MAX_SETUP_BYTES = 32 * 1024;
/** F1: resolved rows keep setup/log this long for idempotent repeats. */
export const RESOLVED_KEEP_MS = 24 * 3_600_000;
/** F14: parse schema for stored hero_progress JSON columns (skills record + loot array). */
export const StoredCoreSchema: z.ZodType<Pick<HeroProgressCore, 'skills' | 'loot'>>;
export class SlidingWindowLimiter {
  constructor(max: () => number, windowMs: number);
  /** True when another event fits the window (does not record it). */
  check(now: number): boolean;
  /** Records one event. */
  record(now: number): void;
  /** check + record in one call (used where every attempt counts). */
  take(now: number): boolean;
}
```

### 2.3 XP crediting (S2)

**Emit point.** `TranscriptsService.applyAgentUsage` (`transcripts.service.ts:224-230`) persists the new cumulative
`TokenUsage` and emits `bus.emit('agent.upserted', publicAgent({ ...agent, usage }))`. Every other `agent.upserted`
carries the stored usage unchanged. The progression module therefore listens to `agent.upserted` and does nothing
unless the four counters differ from its cached mark. There is no new transcripts event and no transcripts edit.

**Binding.** The hero credited is the one whose `boundAgentId === agent.id` **and** `projectId === agent.projectId`,
released or not (heroes keep `boundAgentId` after release, so the final SubagentStop read still credits the hero that
did the work). The module keeps `heroByAgent: Map<agentId, {heroId, projectId}>` plus its reverse
`agentByHero: Map<heroId, agentId>`, seeded from `heroesRepository.list()` at boot, and maintained as follows (F5):
- `hero.upserted`: delete the `heroByAgent` entry of that hero's previous agent (via `agentByHero`), then set the new
  one (if `boundAgentId` is set). A takeover (`chooseHeroForAgent` → reuse with `takenFrom`) moves `boundAgentId` to
  the new agent, so the old agent's entry is gone: later usage of the old agent credits nobody.
- `hero.removed`: drop both entries (and `repo.delete(heroId)`, below).
- `project.merged {from, into}` (an existing bus event, emitted by `projects.service.ts` for runtime merges): rewrite
  every entry with `projectId === from` to `into`. The merge itself may move or delete heroes with raw SQL and no
  `hero.*` event; the credit-time re-read below covers that.
- At credit time the service re-reads `heroesRepository.get(heroId)`: missing → drop the cache entries and credit
  nobody; `projectId`/`boundAgentId` changed → refresh the entry and use the stored values.

The heroes module registers earlier and emits `hero.upserted` synchronously inside its own `agent.upserted` listener,
so a binding made on that same upsert is already in the map. **This listener order (heroes before progression) is
load-bearing**; it is guaranteed by the `dependencies: ['heroes', ...]` of the plugin and locked by a test.

**Algorithm** (`onAgentUpserted(agent, now = Date.now())`):
1. No `agent.usage` → return. `key = sessionId + '\0' + agentId` (agent ids are only unique per session).
2. If the in-memory LRU (2048 keys) holds a mark equal to the usage counters → return (the hot path, no DB).
3. `repo.tx(() => { prev = repo.getMark(...) ?? null; r = advanceUsageMark(prev, usage, weights); if (!r.changed)
   return; repo.upsertMark(..., r.mark, now); if (!progression.enabled || r.xpDelta === 0) return; hero =
   heroByAgent.get(agent.id) (projectId must match, re-read from heroesRepository as above) ?? return;
   read = repo.getCore(hero);
   read.kind === 'corrupt' → warn, credit nothing, keep the row (never overwrite it; F14);
   core = read.kind === 'ok' ? read.core : emptyCore(role, now);
   xp = Math.min(PROGRESSION_LIMITS.maxXp, core.xp + Math.min(r.xpDelta, PROGRESSION_LIMITS.maxXpPerUpdate));
   repo.upsertCore(hero, { ...core, xp, updatedAt: now }) })` (F2: the mark still advances fully; an over-cap delta is
   dropped and never re-credited). Then (outside the tx), if a core was written, emit `progress.upserted` with
   `repo.view(heroId)`; nothing is emitted when `view()` is undefined.
4. Anonymous agents: the mark advances, nothing is credited. Their temporary level is computed on demand:
   `levelForXp(xpFromUsage(agent.usage, weights), curve)`.

**Why it never double-counts (per (sessionId, agentId)).** Marks hold cumulative counters, and an update only raises
them component-wise:
- a re-parse with a fresh read state reaches the same totals (messages are deduplicated by id), so the delta is 0;
- after a restart the persisted marks stop the re-read from counting again;
- debounced duplicate upserts are filtered by the LRU and by `changed`;
- `usage` becoming undefined is ignored;
- totals that drop (another file for the same key) never lower the mark.
XP is the difference of `xpFromUsage` on the cumulative marks, so per-update flooring never loses fractions. Weight
changes apply to future deltas only (a negative difference is clamped to 0). The one cost: tokens below an old peak
after a file switch are not credited (under-count, never over-count).
**Known limit (F3).** A forked/resumed session has a new `sessionId`, so its marks start at zero; if its transcript
copies earlier history, the copied usage is counted again. Accepted (cosmetic); section 7; documented by an S2
fixture test.

**Hero lifecycle.** `hero.removed` → `repo.delete(heroId)` and drop it from both maps. A role change needs no
handler: `progressView` refunds skills of another class on read, and the next skills POST stores the new `classId`.

**Skills/title/heal writes** use `getCore` the same way: `corrupt` → 409 `{error: 'progress row is corrupt'}` and no
write (in M14 such a row is only cleared by deleting the hero); `missing` → `emptyCore`.

### 2.4 Routes

All routes declare `config.access` and a `bodyLimit` (F10): `BODY_LIMIT.default` (16 384 bytes) on every progression
and battle route, `BODY_LIMIT.resolve` (32 768) on resolve; a larger body is 413 before parsing. A resolve `log`
longer than `PROGRESSION_LIMITS.maxLog` (220) is 400 at schema validation, before any replay. Bad ids give 400
(`HeroParamsSchema` from the heroes module schema file, imported read-only, and `BattleParamsSchema`) before any DB
access. Errors use `HttpError` → `{ error, statusCode, details? }`.

| route | access | body / query | success | errors |
|---|---|---|---|---|
| `GET /api/progress` | public | `ProgressListQuerySchema` | 200 `HeroProgress[]` | |
| `GET /api/heroes/:id/progress` | public | | 200 `HeroProgress` (default view without a row) | 400 bad id, 404 hero |
| `POST /api/heroes/:id/skills` | admin | `SkillAllocationSchema` | 200 `HeroProgress` | 400 `details: {code, skillId}` from `validateSkillAllocation` (409 for `respec-disabled`), 404, 409 `baseUpdatedAt`, 409 progression disabled, 409 corrupt row, 413, 429 |
| `POST /api/heroes/:id/title` | admin | `TitleEquipSchema` | 200 `HeroProgress` | 400 not a title id, 409 not owned, 409 corrupt row, 404, 413, 429 |
| `POST /api/heroes/:id/heal` | admin | `EmptyBodySchema` | 200 `HeroProgress` (`koUntil` null) | 409 not knocked out, 409 corrupt row, 404, 413, 429 |
| `POST /api/battles` | admin | `BattleCreateSchema` | 201 `BattleStart` (no `lootSeed`) | 404 project/hero/agent, 400 duplicate member / > `battle.maxParty` / foreign floor / agent has a hero / anonymous disabled, 409 KO'd member (`details: {heroId, koUntil}`), 409 battles disabled, 413, 429 `maxPerHour` |
| `POST /api/battles/:id/resolve` | admin | `BattleResolveSchema` | 200 `BattleOutcome` (also for an identical repeat) | 400 replay error `details: {error, at}` or not finished, 404, 409 already resolved with another log, 409 desync `details: {result, turns}`, 409 `engine version changed` (row → abandoned), 410 abandoned/expired, 413, 429 |
| `POST /api/battles/:id/abandon` | admin | `EmptyBodySchema` | 200 `{ status }` (idempotent for abandoned/expired) | 404, 409 resolved, 413 |
| `GET /api/battles/:id` | admin | | 200 `BattleStart & { outcome: BattleOutcome \| null }` (no `lootSeed`) | 400, 404, 410 `battle details expired` (stripped row) |

Rate limits: battle create uses `SlidingWindowLimiter(() => settings.battle.maxPerHour, 3_600_000)`, and it counts
**only successful creates** (`check` before the work, `record` after the insert), so rejected creates don't burn the
budget. The progress writes (skills/title/heal) share one `WRITE_LIMIT` limiter, and resolve/abandon share another
(both `take` per attempt). They are kept in the service instances, so each `buildApp()` gets its own (the auth pairing
precedent).

### 2.5 Battle service (S3)

**create(body, now)** (steps 3–6 run inside `progressionRepo.txImmediate`, F7)
1. `!battle.enabled || !progression.enabled` → 409 `Battles are disabled (battle.enabled)`. `limiter.check(now)`
   false → 429.
2. Project exists (`projectsRepository.get`) → else 404. `party.length <= settings.battle.maxParty` → else 400.
3. Resolve every member:
   - Heroes: exist and are on `projectId`, appear once, and `!isKnockedOut(progressView)` (a corrupt core → 409).
   - Agents: need `progression.anonymousInBattle`. The agent exists in `agentsRepository`, is not removed and is on
     `projectId`. Its id is not bound to an unreleased hero (else 400 "send the hero instead") and appears once.
4. `battles.abandonOpen(projectId, now)` and `battles.abandonOpenWithHeroes(heroIds, now)` (F6): at most one open
   battle per floor **and** per hero, even after a merge moved a hero mid-battle (a second tab or a stale battle loses
   its stakes, see 7).
5. `seed = randomBytes(4).readUInt32LE(0)`; `lootSeed = randomBytes(4).readUInt32LE(0)` (F4; stored on the row, never
   returned); `setup = buildBattleSetup({ seed, npcKind, party: members (hero: xp/skills from the core, name =
   hero.name; anonymous agent: xp = xpFromUsage(agent.usage ?? zeros, weights), skills {}, temporary true, name =
   agent.role — the web shows the themed role title), curve, difficulty, items, maxTurns })`.
6. Insert a row with id `b-` + 12 hex characters (`randomBytes(6)`), status `open`, `lootSeed`, and `expiresAt =
   createdAt + openTtlMin * 60_000` (F9, stored). On a PRIMARY KEY collision retry once with a new id; a second
   collision is a 500. A setup over `MAX_SETUP_BYTES` is a 500 (logged; cannot happen with shipped content).
7. After the commit: `limiter.record(now)`. Return `BattleStart` (built from the row without `lootSeed`).

**resolve(id, body, now)** (`body.log` is the zod-parsed array)
1. Row missing → 404. Status branches:
   - `resolved`: `sha256(JSON.stringify(body.log)) === row.logHash` → 200 `row.outcome` (works on a stripped row too:
     only the hash and outcome are needed), else 409.
   - `abandoned`/`expired` → 410.
   - `open` but `now > row.expiresAt` → `transition(open → expired)`, 410.
2. `row.setup.engineVersion !== ENGINE_VERSION` (F8) → `transition(open → abandoned)`, 409 `{ error: 'engine version
   changed' }`, before any replay. Then `r = replay(row.setup, body.log)`; `!r.ok` → 400 `{error, at}`; `r.result ===
   null` → 400 "battle not finished". `body.expect` given and ≠ `{r.result, r.turns}` → 409 desync (no state change).
   `logHash = sha256(JSON.stringify(body.log))` over the parsed log (F7).
3. `progressionRepo.txImmediate` (F7):
   - `transition(id, 'open', 'resolved', {...})`; if that returns false (lost a race) → leave the transaction, re-read
     the row **once** and answer with step 1's `resolved` / `abandoned` / `expired` branches. Never re-enter replay; an
     `open` row on the re-read (impossible under BEGIN IMMEDIATE) is a 409.
   - Load the cores of every party hero that still exists (deleted heroes are skipped; a corrupt core is skipped with a
     warning and gets no award).
   - `computeOutcome({ ..., lootSeed: row.lootSeed })` → upsert each `next` core (`upsertCore` returning false = hero
     vanished, skipped), then store `log`, `logHash`, `outcome`, `resolvedAt`.
4. After the transaction: emit `progress.upserted` for each awarded hero (skipped when `view()` is undefined). Return
   the outcome.

**abandon(id, now)**: missing → 404; `resolved` → 409; `abandoned`/`expired` → 200 with that status (idempotent);
`open` → `transition(open → abandoned)`, 200. Abandon and expiry change no progress (no tally; section 7, F11).

**get(id)**: missing → 404. Returns the row as `BattleStart & { outcome }`, never with `lootSeed`. A stripped row
(setup removed by housekeeping: a battle that ended more than 24 h ago) → 410 `battle details expired`; S3 never
synthesizes a placeholder setup.

**Housekeeping.** At boot and then hourly (an `unref` timer, cleared on close), in this order:
`expireOpenBefore(now)` (F9, uses the stored `expires_at`), `stripBefore(now - RESOLVED_KEEP_MS)`,
`prune(now - retentionDays*86_400_000)`, then `pruneExcess(PROGRESSION_LIMITS.maxStoredBattles)` (F1).

**KO timers.** `koUntil` is only a timestamp, set from the server clock. The server runs no timers, emits nothing at
expiry, and re-checks `isKnockedOut` on create. Clients compare it with their own clock (local tool, same host clock);
the web re-renders at the next `koUntil` (section 3.8).

### 2.6 Module wiring (`index.ts`, S1)

```ts
declare module '@fastify/awilix' { interface Cradle { progressionRepository: ProgressionRepository; battlesRepository: BattlesRepository; progressionService: ProgressionService; battlesService: BattlesService } }
export const progressionModule = fp(async (app) => {
  app.diContainer.register({ /* the four singletons, asClass(...).singleton() */ });
  const { cradle } = app.diContainer;
  cradle.progressionRepository.pruneOrphans();
  cradle.progressionService.seed();
  cradle.battlesService.start(); // housekeeping timer; stop() in onClose
  // Registered after the heroes module (dependency below): heroes' agent.upserted listener runs first (load-bearing, F5).
  cradle.bus.on('hero.upserted', (h) => cradle.progressionService.onHeroUpserted(h));
  cradle.bus.on('hero.removed', ({ id }) => cradle.progressionService.onHeroRemoved(id));
  cradle.bus.on('project.merged', (m) => cradle.progressionService.onProjectMerged(m));
  cradle.bus.on('agent.upserted', (a) => cradle.progressionService.onAgentUpserted(a));
  app.addHook('onClose', async () => cradle.battlesService.stop());
  await app.register(progressionRoutes);
  await app.register(battlesRoutes);
}, { name: 'progression', dependencies: ['core-di', 'core-http', 'core-realtime', 'projects', 'agents', 'heroes', 'transcripts'] });
```
S1 stubs: `ProgressionService` with `seed/onHeroUpserted/onHeroRemoved/onProjectMerged/onAgentUpserted` as no-ops plus
the final public signatures throwing `HttpError(501)`. `BattlesService` with `start/stop` no-ops and the rest 501. Both
routes files export an empty `FastifyPluginAsyncZod`. Signatures:
```ts
class ProgressionService { seed(): void; onAgentUpserted(a: Agent, now?: number): void; onHeroUpserted(h: Hero): void; onHeroRemoved(id: string): void;
  onProjectMerged(m: { from: string; into: string }): void;
  list(projectId?: string): HeroProgress[]; get(heroId: string): HeroProgress; setSkills(heroId: string, body: SkillAllocationRequest, now?: number): HeroProgress;
  equipTitle(heroId: string, title: LootId | null, now?: number): HeroProgress; heal(heroId: string, now?: number): HeroProgress }
class BattlesService { start(): void; stop(): void; create(body: BattleCreate, now?: number): BattleStart; resolve(id: string, body: BattleResolve, now?: number): BattleOutcome;
  abandon(id: string, now?: number): { status: BattleStatus }; get(id: string): BattleStart & { outcome: BattleOutcome | null } }
```

---

## 3. Web design

### 3.1 Files and owners (paths under `apps/web/src/`)

| area | files | task |
|---|---|---|
| contract + stubs | `game/battle/types.ts`, `features/battle/types.ts`, `features/battle/encounterBus.ts` (+test), `stores/progressStore.ts` (+test), STUBS `game/battle/controller.ts`, `game/scenes/BattleScene.ts`, `features/battle/labels.ts`, `features/battle/commands.ts`; battle SfxIds in `game/sfxBus.ts` + blank presets in `lib/audio/presets.ts` | W0w |
| controller | `game/battle/controller.ts` (+test) | G1 |
| scene | `game/scenes/BattleScene.ts`, `game/battle/stageLayout.ts`, `game/battle/swirl.ts`, `game/battle/animations.ts` (+tests for the pure three) | G2 |
| art | `game/battle/enemyArt.ts`, `game/battle/fxArt.ts`, `game/textures.ts` (icons `icon-ko`, `icon-bandage`) (+tests) | A1 |
| HUD | `features/battle/hud/{BattleHud,CommandMenu,BattleLog,ResultsPanel,Bar}.tsx`, `features/battle/hud/menuModel.ts` (+test) | U1 |
| labels/copy | `features/battle/labels.ts`, `features/battle/content/{modern,guild,rift}.ts`, `features/battle/copy.ts`, `features/battle/durations.ts` (+tests) | C1 |
| audio | `lib/audio/presets.ts` (battle presets), `lib/audio/music.ts`, `lib/audio/engine.ts`, `lib/audio/types.ts`, `game/sfxBus.ts` (music channel), `features/office/audio/useAudioBridge.ts` (+tests) | AU1 |
| hero sheet | `features/heroes/stats/{HeroStatsSheet,SkillTreeView,StatsTable}.tsx`, `features/heroes/stats/skillPlan.ts` (+test), `features/heroes/HeroEditor.tsx` (tab) | H1 |
| data | `lib/api.ts`, `lib/connection.ts`, `features/battle/commands.ts`, `features/battle/demoProgression.ts` (+test) | P1 |
| HUD badge | `features/office/hud/PortraitChip.tsx`, `features/battle/useProgress.ts` (+test) | HB1 |
| prompt | `features/office/alerts/{types,alertQueue,alertCopy,AlertBox,AlertHost,useAlertFeed}.ts(x)` + tests, `features/battle/encounterRules.ts` (+test) | E1 |
| flow | `features/battle/flowMachine.ts` (+test), `features/battle/useBattleFlow.ts`, `features/battle/party.ts` (+test), `features/battle/PartyPicker.tsx`, `features/battle/BattleOverlay.tsx` | F1 |
| KO | `game/battle/koPresence.ts` (+test), `game/actors/Character.ts` (`setKoBadge`) | K1 |
| loot | `features/heroes/HeroEditor.tsx` (loot options), `features/heroes/stats/LootPanel.tsx`, `features/heroes/stats/HeroStatsSheet.tsx` (mount), `features/battle/lootTitle.ts` (+test), `game/heroLook.ts` (+test) | L1 |
| heal trigger | `game/procgen/types.ts` (`FurnitureAction` + `'infirmary'`), `game/furnitureTriggers.ts` (+test), `game/procgen/triggers.ts`, `features/office/useFurnitureTriggers.ts` | T1 |

### 3.2 Web contract (W0w)

`game/battle/types.ts` (verbatim):
```ts
import type { BattleEvent, BattleNpcKind, BattleResult, BattleSetup, BattleState, HeroAppearance, PlayerAction } from '@tagconn/shared';

export type BattleStyle = 'modern' | 'guild' | 'rift';
export const BATTLE_SCENE_KEY = 'battle';
/** ms. Reduced motion uses `stingMs` instead of swirl/hold/reveal and `returnMs` becomes a 120 ms fade. */
export const BATTLE_TIMING = { swirlMs: 650, holdMs: 100, revealMs: 250, returnMs: 300, stingMs: 120, lungeMs: 120, shakeMs: 160, faintMs: 400, swapMs: 250, musicFadeMs: 400 } as const;

export type BattlerLook =
  | { kind: 'hero'; appearance: HeroAppearance; role: string; roleColor: number; style: BattleStyle }
  | { kind: 'anon'; role: string; roleColor: number; style: BattleStyle }
  | { kind: 'enemy'; npcKind: BattleNpcKind; style: BattleStyle };

export interface TimelineItem { seq: number; event: BattleEvent; text: string; durationMs: number; startedAt: number }
export interface BattleView {
  setup: BattleSetup;
  /** State after every queued event (the HUD animates bars toward the values carried by `current`). */
  state: BattleState;
  current: TimelineItem | null;
  busy: boolean; // events still playing: commands disabled
  lines: readonly string[]; // full text of every played line (aria-live, scrollback)
  result: BattleResult | null; // set once the 'end' event has PLAYED
}
export interface ControllerOptions {
  text(e: BattleEvent, setup: BattleSetup, state: BattleState): string; // '' = silent event (no log line)
  durationMs(e: BattleEvent, text: string, reduced: boolean): number;
  reduced: boolean;
  now(): number;
}
export interface BattleController {
  view(): BattleView;
  subscribe(cb: (v: BattleView) => void): () => void;
  act(a: PlayerAction): { ok: true } | { ok: false; error: string }; // rejected while busy/ended/illegal
  tick(nowMs: number): void; // advances the timeline; called by the scene's update (and a RAF fallback in the HUD)
  skip(): void; // finish the current item now
  actionLog(): readonly PlayerAction[];
  destroy(): void;
}
export type CreateBattleController = (setup: BattleSetup, opts: ControllerOptions) => BattleController;

export interface StageInsets { bottom: number } // CSS px covered by the DOM command panel
export interface BattleSceneInput {
  controller: BattleController;
  style: BattleStyle;
  reducedMotion: boolean;
  party: readonly BattlerLook[];
  enemy: BattlerLook;
  insets: StageInsets;
}
export interface BattleSceneHandle {
  /** Resolves when the entry transition finished (the HUD shows after it). */
  readonly ready: Promise<void>;
  setInsets(i: StageInsets): void;
  /** Return transition, then the scene stops and `onClosed` runs; resolves once the office is visible. */
  close(): Promise<void>;
  /** Immediate teardown (unmount, game destroy). Idempotent. */
  destroy(): void;
}
/** Implemented in game/scenes/BattleScene.ts. */
export type LaunchBattle = (game: Phaser.Game, input: BattleSceneInput, onClosed: () => void) => BattleSceneHandle;
```

`features/battle/types.ts` (verbatim):
```ts
import type { BattleNpcKind, BattleOutcome, BattleResult, BattleStart, ClassId, PartyRef, PlayerAction } from '@tagconn/shared';
import type { BattleStyle } from '../../game/battle/types';

export interface EncounterOffer { npcId: string; kind: BattleNpcKind; name: string; style: BattleStyle; projectId: string; at: number }
export type EncounterChoice = 'battle' | 'ignore' | 'expired';

export interface PartyCandidate {
  key: string; // heroId or 'agent:<agentId>'
  ref: PartyRef;
  name: string;
  classId: ClassId;
  level: number;
  temporary: boolean;
  maxHp: number;
  working: boolean; // bound live agent, status active, activity not idle
  koUntil: number | null;
  selectable: boolean;
}

export type FlowState =
  | { phase: 'idle' }
  | { phase: 'offered'; offer: EncounterOffer } // waiting in the alert queue (not held yet)
  | { phase: 'prompt'; offer: EncounterOffer } // alert visible, NPC held
  | { phase: 'picking'; offer: EncounterOffer }
  | { phase: 'starting'; offer: EncounterOffer; party: readonly PartyRef[] }
  | { phase: 'fighting'; offer: EncounterOffer; start: BattleStart }
  | { phase: 'resolving'; offer: EncounterOffer; start: BattleStart; log: readonly PlayerAction[]; result: BattleResult; turns: number }
  | { phase: 'results'; offer: EncounterOffer; start: BattleStart; outcome: BattleOutcome }
  | { phase: 'error'; offer: EncounterOffer; message: string; start: BattleStart | null };

export type FlowEvent =
  | { t: 'offer'; offer: EncounterOffer } | { t: 'shown'; npcId: string } | { t: 'choice'; npcId: string; choice: EncounterChoice }
  | { t: 'withdraw'; npcId: string } // NPC left / an agent started waiting (before 'picking')
  | { t: 'pick'; party: readonly PartyRef[] } | { t: 'cancel' } // picker cancelled
  | { t: 'started'; start: BattleStart } | { t: 'ended'; log: readonly PlayerAction[]; result: BattleResult; turns: number }
  | { t: 'resolved'; outcome: BattleOutcome } | { t: 'failed'; message: string } | { t: 'close' };

export type FlowEffect =
  | { do: 'hold'; npcId: string } | { do: 'release'; npcId: string } | { do: 'dismiss'; npcId: string }
  | { do: 'withdrawAlert'; npcId: string }
  | { do: 'create'; offer: EncounterOffer; party: readonly PartyRef[] }
  | { do: 'openScene'; start: BattleStart } | { do: 'resolve'; start: BattleStart; log: readonly PlayerAction[]; result: BattleResult; turns: number }
  | { do: 'abandon'; battleId: string } | { do: 'closeScene' };
```

`features/battle/encounterBus.ts` (full, tiny, the `sfxBus` pattern, with a test):
```ts
export interface EncounterBus {
  offer(o: EncounterOffer): void; onOffer(cb: (o: EncounterOffer) => void): () => void;
  shown(npcId: string): void; onShown(cb: (npcId: string) => void): () => void;
  choose(npcId: string, c: EncounterChoice): void; onChoice(cb: (npcId: string, c: EncounterChoice) => void): () => void;
  withdraw(npcId: string): void; onWithdraw(cb: (npcId: string) => void): () => void;
  clear(): void;
}
export const encounterBus: EncounterBus;
```

`stores/progressStore.ts` (full, a copy of the `heroStore` hardening: a null-prototype map, `Object.hasOwn`):
`progress: Record<heroId, HeroProgress>`, `setAll(list)`, `upsert(p)`, `remove(heroId)`, `getProgress(map, id)`,
`registerProgressEvents(socket)` (`'hero:progress'` → upsert, `'hero:remove'` → remove).

STUBS with final signatures:
- `game/battle/controller.ts`: `export const createBattleController: CreateBattleController`. The stub applies
  `applyAction` and plays every event at once (`busy` is always false).
- `game/scenes/BattleScene.ts`: `export class BattleScene extends Phaser.Scene` (key `BATTLE_SCENE_KEY`, empty
  `create`) and `export const launchBattle: LaunchBattle`. The stub resolves `ready`/`close` immediately and calls
  `onClosed`.
- `features/battle/labels.ts`: `battleLabel(style, kind: 'move' | 'item' | 'branch' | 'skill' | 'class' | 'loot' |
  'enemy' | 'type' | 'status', id: string): string`. The stub returns the humanized id ("refactor-strike" →
  "Refactor Strike").
- `features/battle/commands.ts`: `startBattle(b: BattleCreate): Promise<BattleStart>`, `resolveBattle(id, b:
  BattleResolve): Promise<BattleOutcome>`, `abandonBattle(id): Promise<void>`, `saveSkills(heroId, skills,
  baseUpdatedAt?): Promise<HeroProgress>`, `equipTitle(heroId, title: LootId | null): Promise<HeroProgress>`,
  `healHero(heroId): Promise<HeroProgress>`. Stub bodies `throw new Error('not implemented')`.

### 3.3 Encounter prompt (E1, reusing the M13 alerts)

- `encounterRules.ts`. A pure function `shouldOfferEncounter(e: EncounterEvent, ctx: { settings: Settings; anyWaiting:
  boolean; canWrite: boolean; flowIdle: boolean; multiverse: boolean }): boolean`. All of these must hold: `e.phase ===
  'appeared'`; `isBattleNpcKind(e.kind)`; `battle.enabled && progression.enabled && office.alerts.enabled`; not
  Multiverse; `flowIdle`; `!anyWaiting`; `canWrite` (demo mode, or `authStore` reports admin; the routes are `admin`);
  `dramaRng('offer:' + e.id)() < battle.offerChance` (seeded, so asking twice gives the same answer).
- `types.ts`:
  - `AlertKind` gains `'encounter'`, with `ALERT_PRIORITY.encounter = 0`, below `done`.
  - `AlertInput` and `AlertItem` gain `encounter?: EncounterOffer` and `ttlMs?: number`.
  - `agentId` for encounters is `encounter:<npcId>`.
- `alertQueue.ts`:
  - Encounters never coalesce.
  - `agentCooldownSec` is skipped for `encounter:*` ids.
  - Expiry uses `item.ttlMs ?? autoDismissSec * 1000`.
  - `tickAlerts` additionally returns `expired: readonly AlertItem[]`. This is a new field; existing callers ignore it.
  - `withdrawAlert(state, agentId)` drops a pending or visible item.
  - Encounters still use bucket tokens, so they are rate-limited with everything else.
- `useAlertFeed.ts`:
  - Subscribes to `encounterBus.onOffer`. Each offer becomes `offerAlert({ kind: 'encounter', agentId:
    'encounter:'+npcId, key: 'appeared', encounter, ttlMs: autoIgnoreSec*1000 })`.
  - When an encounter item is shown it calls `encounterBus.shown(npcId)` and plays `battle-encounter`.
  - When an encounter item expires it calls `encounterBus.choose(npcId, 'expired')`.
  - `encounterBus.onWithdraw` → `withdrawAlert`.
  - The hook also returns `choose(item, c)`.
- `alertCopy.ts`: encounter copy per style.
  - modern: "A wild {name} appeared!", body "Battle it out or let it be?"
  - guild: "A wild {name} blocks the hall!"
  - rift: "Hostile {name} detected!"
- `AlertBox.tsx` gets two optional props:
  - `actions?: readonly { label: string; onClick(): void; primary?: boolean }[]`, which replace "Show me";
  - `portrait?: ReactNode`, where the encounter passes `<EnemyPortrait kind style />` from `enemyArt`'s canvas painter.
  - Buttons carry the UI-sound attribute convention: `data-sfx="ui-confirm"` on Battle, `ui-back` on Ignore.
  - Non-modal, no focus steal (M13 rule).
- `AlertHost.tsx`: encounter items render with Battle/Ignore. Battle calls `choose(item, 'battle')`, Ignore calls
  `choose(item, 'ignore')`. Both dismiss.

Flow on the NPC (F1 `useBattleFlow`, via the `FlowEffect`s):
1. `encounter appeared` + rules → `offer`.
2. `shown` → `hold(npcId)`. If `OfficeGame.holdEncounter` returns false, the NPC is already exiting: `withdrawAlert`.
3. Ignore or expired → `release` (the script continues to its bit and reaction: the M13 chaos).
4. `encounter left` while offered or prompt → `withdrawAlert` (+ `release`, a no-op).
5. Any agent turns waiting/blocked while offered or prompt → `withdrawAlert` + `release`.
6. Battle → `picking` (still held). Picker cancel → `release`.
7. After the battle: `won` → `dismiss` (the NPC leaves, defeated); `lost`/`fled`/`timeout`/error → `release`.

### 3.4 Party picker (F1)

- `party.ts`: `partyCandidates(heroes, agents, progress, settings, projectId, now): PartyCandidate[]`.
  - Candidates are the floor's heroes plus, when `anonymousInBattle`, live subagents without a hero (temporary level
    from usage, `role` → class).
  - `working` = the hero's bound agent is live with `status === 'active'` and `activity !== 'idle'`.
  - KO'd heroes are unselectable and keep their `koUntil` for the timer.
  - Order: selectable first, then level descending, then name.
  - Pure, tested.
- `PartyPicker.tsx` is a modal (`role="dialog" aria-modal="true" data-modal="battle-party"`, `useModalFocus` trap).
  - Rows show a portrait, name, class label, "Lv N" ("Lv ~N" for temporary), max HP, a "⚙ working" tag, and KO'd rows
    greyed with "💫 4:12".
  - Selection order is the battle order (the first pick fights first, shown as 1–4 badges).
  - Keyboard: ↑/↓ moves (`ui-hover`), Space toggles (`ui-toggle`), Enter starts (`ui-confirm`), Esc cancels (`ui-back`).
  - The picker opens with `ui-open` and closes with `ui-close`.
  - Start is disabled with 0 selected; at `maxParty` more picks are disabled (`ui-error` on a try).

### 3.5 BattleScene (G2) and controller (G1)

**Split.** Phaser draws the stage: backdrop, platforms, sprites, hit/effect animations, damage numbers, transitions.
The DOM HUD (U1) draws the HP/FOCUS bars, the typewriter log, the command menu and the results. Both are driven by
one `BattleController`. This deviates from the plan's "menu in the scene" on purpose (accessibility, reuse of the M13
typewriter/JRPG frame, parallel file ownership). Section 7 has the trade-off.

**Controller** (`controller.ts`, pure TS, no Phaser/React):
- `act(a)` → `applyAction`, which appends the events to the timeline. Each item gets `text = opts.text(...)` and
  `durationMs = opts.durationMs(...)`.
- `tick(now)` advances when `now >= startedAt + durationMs`. Silent events (`text === ''`) take their duration
  without a log line (`turn`, `focus`).
- `busy` stays true until the queue is empty. `result` is set once the `end` item has played.
- `skip()` ends the current item. The log keeps every played line.
- Tests: fake clock, event order, `busy` gating, illegal action rejected, `actionLog` equals the accepted actions,
  replaying `actionLog` reproduces `view().state`.

**Layout** (`stageLayout.ts`, pure): `stageLayout(w, h, insetBottom): { enemy: {x, y, scale}; hero: {x, y, scale};
enemyPlatform: Ellipse; heroPlatform: Ellipse; dmgAnchor: {enemy: Point; hero: Point} }`.
- The enemy sits top-right at (0.72w, 0.30·stageH) on an ellipse platform; the active hero sits bottom-left at
  (0.28w, 0.78·stageH), facing right (horizontal flip). `stageH = h - insetBottom`.
- Integer scale `clamp(floor(stageH / 90), 2, 6)` for heroes, +1 for enemies.
- Bench members are not drawn in the scene (HUD pips).

**Sprites.**
- Heroes are painted with `paintPortrait` (full crop) onto a canvas texture `battle-hero-<i>` (the bitmaps
  `hud/Portrait` uses; `game/heroPreview.ts`).
- Enemies use `enemyArt.paintEnemyTexture(scene, npcKind, style)`: creature kinds come from `CREATURE_BITMAPS`
  upscaled with 2 frames, costumed humans (police/cia/guest) are painted with the skin's costume.
- Effect textures come from `fxArt.paintFxTextures(scene)`: slash, sparkle, shield bubble, status icons
  (stun stars, merge-conflict "<<>>", burnout flame, buff arrow), and the swirl wedge.

**Backdrops** (code-drawn per style):
- modern: carpet gradient, a window band and a desk silhouette;
- guild: flagstones, a torch glow and banners;
- rift: a starfield and a nebula gradient.
Each is drawn once into a RenderTexture on create.

**Animations** (`animations.ts`, pure descriptors `animFor(e: BattleEvent, reduced): AnimStep[]`; the scene runs
them with tweens):

| event | animation | sound |
|---|---|---|
| `use` | attacker lunges 8 px toward the target | — |
| `damage` | target flashes white 2 frames, shakes 3 px, damage number pops up | `battle-hit` / `-super` / `-weak` (`battle-crit` overlays) |
| `miss` | "MISS" | `battle-miss` |
| `heal` | sparkle | `battle-heal` |
| `status on` | icon above the sprite | `battle-status` / `battle-buff` / `battle-shield` |
| `faint` | drop 6 px, fade 400 ms | `battle-faint` / `battle-enemy-faint` |
| `swap` | slide out/in 250 ms | `battle-swap` |
| `item` | item icon | `battle-item` |
| `run ok` | hero slides off left | `battle-run` |

Every animation starts on the same frame its sound is emitted. Reduced motion: no lunge or shake, a static flash, no
slides (instant swap).

**Transitions** (`swirl.ts`, pure geometry `swirlWedges(t: 0..1, w, h, count=8): Polygon[]`, tested):
- Entry: emit `battle-swirl` on the first frame of the swirl tween (650 ms, eight black wedges rotating and growing
  from the centre), hold black 100 ms, then the iris opens (250 ms) on the stage. The enemy slides in from the right
  during the reveal. Music starts (`sfxBus.setMusic({ kind: 'battle', style })`, 400 ms fade-in) when the reveal
  begins. `ready` resolves when the reveal ends.
- Reduced motion: no swirl. `battle-sting` plus a 120 ms fade from black; the music starts at the same moment.
- Return (`close()`): emit `battle-return` and `sfxBus.setMusic(null)` (300 ms fade-out) on the first frame of the iris
  close (300 ms). Then stop the scene and call `onClosed`, which lets the office show and take input again. Reduced
  motion: a 120 ms fade with the same sounds.

**Input.** The DOM HUD owns keyboard and mouse for commands. The scene only lets a pointer click on the stage skip the
current text (`controller.skip()`). The office scene's input is disabled while the battle runs (PM, 3.10).

### 3.6 Battle HUD (U1)

`BattleHud.tsx`:
- Root: `role="dialog" aria-modal="true" aria-label="Battle" data-modal="battle"`, which pauses app hotkeys through
  `isModalOpen`, with a `useModalFocus` trap.
- Enemy card (top-left): name, "Lv N", type chip, HP bar.
- Hero card (right, above the panel): name, "Lv N", HP bar with numbers, FOCUS bar, up to 3 bench pips (portraits,
  fainted ones greyed).
- Bottom panel (full width, measured with a ResizeObserver → `handle.setInsets({ bottom })`):
  - `BattleLog` on the left 60 %: a typewriter of `current.text` with M13's `typewriterText`, 40 chars/s, a
    `battle-text` blip every 3rd character; plus a visually hidden `aria-live="polite"` list of `lines`;
  - `CommandMenu` on the right 40 %.
- `Bar.tsx` tweens toward the value carried by the current event (`damage.hp`, `heal.hp`, `focus.focus`) over
  `durationMs * 0.6`, with green > 50 % > amber > 20 % > red. No tween under reduced motion.
- Phone: the cards shrink, the panel is 44 % of the height, commands are a 2×3 grid of ≥ 44 px targets.

`menuModel.ts` (pure, tested):
`menuReducer(state: MenuState, input: MenuInput, ctx: { setup, battle: BattleState, busy }): { state; action?: PlayerAction; sfx?: SfxId }`.
- Root items: Fight / Skill / Item / Swap / Run (2 columns, 3 rows). `phase === 'forced-swap'` opens the Swap list
  with Back disabled.
- Fight = move 0. Skill lists moves 1..n with name, focus cost, type chip and the `damagePreview` effectiveness
  ("Super effective" / "Not very effective"); unaffordable moves are disabled.
- Item lists items with counts and asks for a target member when the effect is `heal` or `cure`. Swap lists living
  bench members.
- Keys: arrows/WASD move (`ui-hover`), Enter/Space/Z confirm (`ui-confirm`, `ui-error` when disabled), Esc/X/Backspace
  back (`ui-back`), digits 1–5 jump.
- While `busy`, confirm and click call `controller.skip()` instead.
- Mouse hover moves the cursor; click confirms. Every button has an `aria-label` and the uiSound `data-sfx`
  attributes.

`ResultsPanel.tsx` (for phase `results`, or `resolving` with a spinner "Recording the battle…"):
- Header with `battle-victory` / `battle-defeat` on the reveal tween start: "Victory!" / "Defeated…" / "Got away
  safely" / "{Enemy} lost interest".
- Per hero: an XP bar animating from `levelBefore` to `levelAfter` (`battle-xp-tick` every 120 ms while it fills).
  On a level-up, "Level up! 11 → 12" with `battle-level-up` at its banner tween start, plus "+N skill point(s)".
- KO rows: "💫 resting 5 min" (working heroes: "🩹 keeps working").
- A loot card ("🎁 Hardhat for Brom", `battle-loot` at its reveal) and a link "Open hero sheet" (opens the Heroes
  panel on that hero, Stats & Skills tab).
- Continue (Enter, autofocus) → flow `close`.
- Reduced motion: everything appears at once, one `battle-xp-tick`, then the level-up and loot stings.
- Errors (phase `error`): the message and "Close"; the NPC is released.

### 3.7 Copy, labels, durations (C1)

- `content/{modern,guild,rift}.ts`: `BattleLabels = { move: Record<moveId, string>; item: Record<ItemId, string>;
  branch: Record<`${ClassId}.${0|1|2}`, string>; skill: Partial<Record<SkillId, string>>; class: Record<ClassId,
  string>; loot: Record<LootId, string>; enemy: Record<BattleNpcKind, string>; type: Record<BattleType, string>;
  status: Record<StatusId, string> }`.
  - Move nodes take the move's name. Passive nodes default to "+4% ATK" style text built from the effect.
  - Examples: modern Hotfix / guild Mending Rune / rift Patch Pulse; title-bug-squasher → Bug Squasher / Slime Slayer
    / Void Purger; class developer → Developer / Artificer / Engineer; type `bug` → Bug / Vermin / Glitch.
- `copy.ts`: `battleText(e, setup, state, style): string`, e.g. "Brom used Hotfix!", "It's super effective!", "A
  critical hit!", "Wolf is stunned!", "Brom fainted!", "Got away safely!", "Brom's Coffee restored 13 HP.", "Brom is
  hit by its own merge conflict!". `turn` and `focus` are silent.
- `durations.ts`: base `use 450, damage 650, miss 500, heal 550, status 600, resisted 500, skip 550, confused 550, swap
  600, faint 900, item 550, run 700, end 900, start 0, turn 0, focus 0`, at least `text.length / 40 * 1000 + 250`.
  Reduced motion: 60 % of that, at least 300 (start/turn/focus stay 0).
- Test: every id in `MOVES`, `ITEM_IDS`, `CLASS_IDS`, `LOOT_IDS`, `BATTLE_NPC_KINDS`, types, statuses and every branch
  has a label in all three styles; move names ≤ 18 characters, loot ≤ 24; `battleText` is non-empty for every
  non-silent event kind.

### 3.8 Hero sheet "Stats & Skills" (H1) and HUD badge (HB1)

- `HeroEditor.tsx` gets a sub-tab bar (`Look` | `Stats & Skills`, `ui-tab` sound, `role="tablist"`). `Look` is the
  existing body.
- `HeroStatsSheet.tsx`:
  - Level, an XP bar (`levelXp..nextLevelXp`, "MAX" at maxLevel), class label and type chip.
  - `StatsTable` (HP/ATK/DEF/SPD/FOCUS from `statsFor` with the *planned* allocation, deltas shown in green).
  - Record: wins / losses / flees.
  - KO state with the timer, plus a "☕ Coffee break" button → `healHero` (admin).
- `SkillTreeView.tsx`: 3 columns (branches) × 4 tiers. A node shows its label, rank/maxRank, minLevel, a lock with the
  reason (level / prerequisite), and +/− buttons (keyboard: Tab between nodes, +/− keys).
  - Points left come from `skillPlan`.
  - "Save" sends the full allocation with `baseUpdatedAt`; a 409 conflict shows the HeroPanel-style reload prompt.
  - "Respec" (when `allowRespec`, or the allocation is overspent/invalid) clears the plan.
  - `ui-confirm` / `ui-error` on +/−.
- `skillPlan.ts` (pure, tested): `planFrom(progress)`, `canAdd(plan, nodeId, ctx)`, `canRemove(plan, nodeId, ctx)` (a
  removal that would orphan a dependent rank is refused unless respec), `apply(plan, op)`, `pointsLeft(plan)`.
  Everything goes through `validateSkillAllocation`.
- Read-only when the user cannot write (not admin in live mode): buttons are disabled with "Pair this browser to
  change skills".
- `PortraitChip.tsx` gets a bottom-left badge "12" (rounded, ink-950 on the role colour).
  - Anonymous agents with usage get "~3" at 70 % opacity.
  - KO'd heroes get a tiny "💫"; working KO'd heroes get "🩹".
  - The aria-label gains ", level 12".
- `useProgress.ts`: `useHeroProgress(heroId)`, `useAgentLevel(agent, hero)` (returns `{ level, temporary } | null`;
  null when `progression.enabled` is off), and `useNow(untilTs)`, a timer that re-renders at the next `koUntil`.

### 3.9 Data, demo mode, KO presence, loot, heal trigger

**P1 data.**
- `lib/api.ts`: `progress(projectId?)`, `heroProgress(id)`, `saveSkills(id, body)`, `equipTitle(id, body)`,
  `healHero(id)`, `createBattle(body)`, `resolveBattle(id, body)`, `abandonBattle(id)`.
- `lib/connection.ts`: `registerProgressEvents(s)` in `wireLive`; seed `progressStore.setAll(snap.progress ?? [])` in
  `resyncs` and on a pushed snapshot; `moveProject` needs nothing (no projectId on the client store key).
- `commands.ts`: live calls go to `api.*`; demo calls go to `demoProgression`.
- `demoProgression.ts` keeps localStorage `tagconn.demoProgress.v1` = `{ cores: Record<heroId, HeroProgressCore>;
  marks: Record<string, UsageCounters>; battles: Record<id, { setup; lootSeed; status }> }`.
  - It credits XP from the demo agents' `usage` through `advanceUsageMark` (subscribed to `officeStore`).
  - Battles are created with `buildBattleSetup` (seed and its own `lootSeed` from `crypto.getRandomValues`; the demo
    has no server, so the loot seed lives in local storage) and resolved with `replay` + `computeOutcome`, the
    server's exact path.
  - It pushes views into `progressStore`. Bad storage never throws (the ADR #25 pattern).

**K1 KO presence.**
- `koPresence.ts`: pure `koBadgeFor(input: { heroId: string | null; lifecycle: 'quest' | 'resting' | 'leaving';
  agent?: Pick<Agent, 'status' | 'activity'> }, progress: HeroProgress | undefined, now): 'dizzy' | 'bandage' | null`.
  - `null` unless the hero is KO'd.
  - `bandage` when the lifecycle is `quest` with `status === 'active'` and `activity !== 'idle'`; otherwise `dizzy`.
  - A waiting/blocked hero gets `bandage` and keeps its bubble. The icon slot is the strain slot's mirror, so it never
    hides the bubble.
- `class KoPresence { apply(chars: Iterable<KoTarget>, progress, agentOf, now): void }` calls `setKoBadge` only when
  the value changed.
- `Character.setKoBadge(kind: 'dizzy' | 'bandage' | null)`: an icon at (−7, −17) (`icon-ko` with a slow 2-frame bob
  unless static, `icon-bandage` static), hidden while the character is leaving.
- It never calls `walk`, `teleport`, `setSeated` or SeatAllocator (tested with a fake Character).

**L1 loot cosmetics.**
- `heroLook.ts`: `resolveHeroCostume` uses `appearance.lootHat ?? hat` and `lootProp ?? prop`; the loot ids map to the
  M13 costume hats/staffs.
- `HeroEditor.tsx`: the Hat and Prop selects append an "Unlocked" optgroup with the owned loot hats/props (labels from
  `battleLabel(style, 'loot', id)`). Picking one sets `lootHat`/`lootProp`, and picking a normal hat clears it. Locked
  loot is not listed.
- `LootPanel.tsx` (in the stats sheet): a grid of all 14 loot items, owned in colour and locked as silhouettes "???",
  with "Equip title" / "Unequip" → `equipTitle`.
- `lootTitle.ts`: `plateTitle(hero, progress, theme, roleTitleFn): string`. The precedence is equipped loot title >
  hero custom title > themed role title. The PM uses it in `applyMemberLook`.

**T1 heal trigger** (the plan's "coffee-machine/fountain furniture trigger"):
- `FurnitureAction` gains `'infirmary'`, with `TRIGGER_KINDS.infirmary = ['coffee-machine', 'water-cooler']`.
- It is never placed by procgen: exclude it like `receptionist` in `TRIGGER_PLACE`'s type and `triggers.ts`. It is
  last in `TRIGGER_ORDER`.
- `TRIGGER_PANEL.infirmary = { panel: 'Coffee break', hotkey: '' }`. The `furnitureTriggers.test` hotkey test exempts
  it.
- Labels: Coffee machine / Healing fountain / Med-bay.
- `useFurnitureTriggers` intercepts `infirmary` before `routeFurnitureClick`. If no modal is open, it calls
  `healHero` for every KO'd hero of the selected floor; then it shows a toast-free `sfxBus.emit({id: 'battle-heal'})`
  only. Without a write permission it does nothing.

### 3.10 PM integration edits (W3-W)

`game/OfficeGame.ts`
1. Imports: `BattleScene, launchBattle` from `./scenes/BattleScene`; `BATTLE_SCENE_KEY, type BattleSceneInput, type
   BattleSceneHandle` from `./battle/types`.
2. Constructor, after `new Phaser.Game(...)`: `this.game.scene.add(BATTLE_SCENE_KEY, BattleScene, false);`.
3. Field `private battle: BattleSceneHandle | null = null;` and the methods:
```ts
holdEncounter(npcId: string): boolean { return this.scene?.holdNpc(npcId) ?? false; }
releaseEncounter(npcId: string): void { this.scene?.releaseNpc(npcId); }
dismissEncounter(npcId: string): void { this.scene?.dismissNpc(npcId); }
get battleOpen(): boolean { return this.battle !== null; }
openBattle(input: BattleSceneInput): BattleSceneHandle | null {
  if (!this.scene || this.battle || this.transitioning) return null;
  this.scene.setBattleActive(true);
  this.battle = launchBattle(this.game, input, () => { this.scene?.setBattleActive(false); this.battle = null; });
  return this.battle;
}
```
4. `destroy()`: `this.battle?.destroy(); this.battle = null;` before `this.game.destroy(true)`.

`game/scenes/OfficeScene.ts`
1. `OfficeState` gains `progress: Readonly<Record<string, HeroProgress>>`.
2. Public pass-throughs: `holdNpc(id) { return this.npcs.hold(id); }`, `releaseNpc(id) { this.npcs.release(id); }`,
   `dismissNpc(id) { this.npcs.dismiss(id); }`.
3. `setBattleActive(on: boolean)`: `this.input.enabled = !on; this.cameras.main.setVisible(!on);` (the office keeps
   simulating; rendering is skipped behind the opaque battle stage).
4. Field `private ko = new KoPresence();`. In `update()`, after the NPC update, with a 1 s throttle:
   `this.ko.apply(this.koTargets(), this.state.progress, (id) => this.agentById(id), Date.now())`. `koTargets()` yields
   `{ char, heroId: c.heroId, lifecycle: c.lifecycleFrame.state, agentId: c.boundAgentId }` for `characters`.
   `setOfficeState` also calls it once (instant).
5. `applyMemberLook` (`:1434-1435`): `const title = plateTitle(hero, hero ? state.progress[hero.id] : undefined, theme,
   () => themedTitle);` then `setLook({ ..., title })`.
6. `enterResting`: unchanged (the "Resting" title stays; the 💫 comes from KoPresence).

`features/office/OfficeView.tsx`
1. In the `OfficeState` build: `progress: useProgressStore((s) => s.progress)` (add it to the memo deps).
2. After `useAudioBridge(active);`: `useBattleFlow(game);`.
3. Inside the `wrap` div, after `<AlertHost onShowMe={selectAgent} />`: `<PartyPicker /> <BattleOverlay game={game} />`.
   Both read the flow store and render nothing when idle.

`useBattleFlow(game)` (F1) holds the flow in a zustand store `features/battle/flowStore` (inside `useBattleFlow.ts`).
It runs `flowMachine.reduce(state, event) → { state, effects }`, and executes the effects:
- `hold/release/dismiss` → `game.*Encounter`;
- `create` → `commands.startBattle`;
- `openScene` → `game.openBattle({...})` with looks from the hero store/theme;
- `resolve` → `commands.resolveBattle` with `expect`;
- `abandon` on unmount/floor change mid-battle;
- `closeScene` → `handle.close()`.
It also subscribes to `game.on('encounter')` and `encounterBus`.

Then: ROOT `pnpm typecheck && pnpm test && pnpm build`, `pnpm test:perf`, the smoke in 6.8, and a commit.

---

## 4. Balance (starting numbers; W0d's simulation test is the arbiter)

### 4.1 XP curve

`xpForLevel(L) = 1500 · (L−1)²`, max level 50:

| level | 2 | 5 | 10 | 12 | 15 | 20 | 25 | 30 | 40 | 50 |
|---|---|---|---|---|---|---|---|---|---|---|
| XP | 1,500 | 24,000 | 121,500 | 181,500 | 294,000 | 541,500 | 864,000 | 1,261,500 | 2,281,500 | 3,601,500 |

Typical Claude Code transcripts (Sonnet/Opus with prompt caching) and the XP they give at the default weights
(output ×1, input ×0.2, cache creation ×0.1, cache read ×0):

| usage | output tokens | uncached input | cache creation | cache read | XP |
|---|---|---|---|---|---|
| one focused subagent task (15–40 turns) | 10–40k | 1–5k | 100–400k | 1–5M | ~20–80k → L4–8 |
| a workhorse developer hero, ~4 tasks in a heavy day | ~120k | ~15k | ~1M | ~15M | ~220k → L13 |
| the PM main session, a heavy day | 150–300k | 20–50k | 1–3M | 50–200M | ~260–600k → L14–21 |

So one task gives about level 5, and a heavy day gives level 10–15 for working heroes (the target). Cache reads are
excluded: at ×1 they would be 50–200M a day and every hero would hit the cap in a day. Afterwards: L20 ≈ 2–3 heavy
days, L30 ≈ 1–2 weeks, L50 ≈ 1–2 months. Anonymous subagents get the same curve from their own usage (typically L4–8).
The F2 clamps (`maxXpPerUpdate` 5M per update, `maxXp` 1e12) are far above any real update (a whole heavy PM day is
< 1M XP), so they only bite on forged or corrupt usage.

### 4.2 Stats

Per class, base values B (Pokémon-style; `progressionContent.CLASS_BASE`):

| class (type) | hp | atk | def | spd | focus |
|---|---|---|---|---|---|
| developer (build) | 60 | 75 | 55 | 60 | 50 |
| qa (test) | 65 | 60 | 70 | 55 | 50 |
| architect (design) | 60 | 65 | 60 | 45 | 70 |
| security (secure) | 70 | 60 | 80 | 45 | 45 |
| reviewer (review) | 55 | 65 | 55 | 75 | 50 |
| analyst (insight) | 55 | 55 | 55 | 65 | 70 |
| lead (lead) | 75 | 55 | 65 | 55 | 50 |
| adventurer (grit) | 60 | 60 | 60 | 60 | 50 |

`statsFor` (integer):
- `hp = floor(2·B·L/100) + L + 10`
- `atk/def/spd = floor(2·B·L/100) + 5`
- `focus = floor(B·L/50) + 10`
- then stat passives: `floor(stat · (100 + pct) / 100)`.

Developer: L1 hp 12 / atk 6 / def 6 / focus 11; L10 32 / 20 / 16 / 20; L30 76 / 50 / 38 / 40; L50 120 / 80 / 60 / 60.

### 4.3 Skill tree template (all classes)

| branch | tier 1 (max 5, min L1) | tier 2 (rank 1, L3) | tier 3 (max 3, L8) | tier 4 (rank 1, L15) |
|---|---|---|---|---|
| 0 offense | ATK +4 %/rank | move O1 | crit +2 %/rank | move O2 |
| 1 defense | DEF +4 %/rank (lead: HP) | move D1 | status resist +8 %/rank | move D2 |
| 2 tempo | SPD +4 %/rank | move T1 | focus regen +1/rank | move T2 |

- Prerequisites: tier n needs tier n−1 of the same branch at rank ≥ 1.
- Cost is 1 point per rank, so a full tree costs 36 points. At 1 point per level plus a bonus every 3 wins, a hero
  fills it around L30.
- Exceptions: qa tier 3 of branch 0 is heal boost +10 %/rank instead of crit; analyst tier 3 of branch 2 is type
  boost +5 %/rank instead of focus regen.

### 4.4 Moves

Basic moves (P40, acc 100, F0, STAB): `commit` (developer), `assert` (qa), `sketch` (architect), `audit` (security),
`comment` (reviewer), `query` (analyst), `delegate` (lead), `shove` (adventurer). Each class move uses the class type
unless it is a heal/shield/buff (those are `neutral`). P = power, acc = accuracy, F = focus cost.

| class | O1 | O2 | D1 | D2 | T1 | T2 |
|---|---|---|---|---|---|---|
| developer | `hotfix` P70 a95 F8 | `refactor-strike` P100 a90 F14 | `stack-trace` P50 F8, stun 25 % 1t | `rubber-duck` heal 40 % + cure F10 | `quick-deploy` P50 prio F6 | `ship-it` P130 a75 F16 |
| qa | `flaky-repro` P60 a95 F8, merge-conflict 30 % 2–3t | `regression-suite` P100 a90 F14 | `unit-test-shield` shield 3t F8 | `green-build` heal 50 % F12 | `smoke-test` P50 prio F6 | `fuzz-barrage` P30×3 a85 F14 |
| architect | `blueprint-beam` P70 a95 F8 | `grand-design` P100 a90 F14 | `load-bearing-wall` shield 3t F8 | `decouple` heal 30 % + cure F10 | `whiteboard-trap` status stun 50 % 1t a90 F8 | `paradigm-shift` P80 a90 F14, buff self 2t |
| security | `pen-test` P70 a95 F8 | `zero-day` P100 a90 F14 | `firewall` shield 3t F8 | `incident-response` heal 40 % + cure F12 | `threat-model` buff self 3t F6 | `lockdown` P40 a95 F12, stun 50 % 1t |
| reviewer | `nitpick` P25×3 a95 F8 | `blocking-review` P100 a90 F14 | `lgtm` heal 40 % F10 | `style-guide` shield 2t + cure F8 | `drive-by-comment` P50 prio F6 | `merge-conflict` P30 F10, merge-conflict 70 % 2–3t |
| analyst | `grep-scan` P70 a95 F8 | `root-cause` P100 a90 F14 | `risk-register` shield 3t F8 | `data-driven` buff self 3t F6 | `spreadsheet-storm` P30 F10, burnout 60 % 3–5t | `deep-dive` P80 a95 crit +20 F14 |
| lead | `escalate` P70 a95 F8 | `crunch-time` P120 a85 F14, self burnout 2t | `roadmap` shield 3t F8 | `team-lunch` party heal 30 % F14 | `standup` status stun 40 % 1t F8 | `pep-talk` buff self 3t + heal 20 % F12 |
| adventurer | `power-swing` P70 a95 F8 | `heroic-charge` P100 a90 F14 | `brace` shield 3t F8 | `second-wind` heal 40 % F10 | `trip` P40 F8, stun 30 % 1t | `last-stand` P90 a90 F14, buff self 2t |

Items: coffee heal 40 %, energy-drink focus 50 %, rubber-duck cure, pizza heal party 25 %.

### 4.5 Type chart (rationale)

Hero attack types against enemy types:
- QA test ×2 vs bug ("tests catch bugs"); devs build ×0.5 vs bug.
- build ×2 vs bureaucrat ("automate the paperwork"), as is secure ×2 (compliance); insight ×0.5 vs bureaucrat.
- insight ×2 vs salesy (analysts see through the pitch); lead ×0.5 vs salesy (PMs buy it).
- design and review ×2 vs rival; test ×0.5 vs rival.
- lead ×2 vs feral ("herding cats"), as is grit; secure ×0.5 vs feral.

Enemy attacks:
- bug ×2 vs build;
- bureaucrat ×2 vs lead;
- salesy ×2 vs design (scope creep);
- rival ×2 vs build;
- feral ×2 vs review (the cat on the keyboard).
The ×0.5 entries mirror these (table in 1.2). Each hero type has at least one super-effective target, and each enemy
has at least one counter class, so picking a party matters.

### 4.6 Enemies and AI

| npc kind | type | hp | atk | def | spd | ai | moves (index 0 basic, P40) | loot (weight) |
|---|---|---|---|---|---|---|---|---|
| monster | bug | 75 | 60 | 55 | 50 | aggressive | `segfault`, `null-pointer` P60 a90, `race-condition` merge-conflict 45 % 2–3t, `memory-leak` burnout 50 % 3–5t | title-bug-squasher 3, hat-hardhat 2, prop-mop 2 |
| police | bureaucrat | 85 | 55 | 70 | 40 | tank | `citation`, `paperwork-pile` P60 a90, `red-tape` stun 35 % 1t, `by-the-book` shield 2t | hat-police-cap 3, title-red-tape-cutter 2, prop-clipboard 2 |
| cia-agent | bureaucrat | 70 | 60 | 60 | 65 | tricky | `redact`, `classified` P65 a85, `surveillance` buff 2t, `interrogate` merge-conflict 45 % | hat-fedora 3, title-redacted 2, prop-clipboard 1 |
| sales-dog | salesy | 70 | 65 | 50 | 70 | aggressive | `pitch`, `upsell` P60 a90, `cold-call` stun 30 % 1t, `synergy` heal 25 % | title-unsold 3, hat-cap 2, prop-parcel 2 |
| guest | rival | 70 | 55 | 60 | 60 | tricky | `small-talk`, `hot-take` P60 a90, `humblebrag` buff 2t, `name-drop` merge-conflict 40 % | title-rival-tamer 3, prop-watering-can 2, hat-cap 1 |
| office-cat | feral | 60 | 65 | 45 | 90 | aggressive | `scratch`, `zoomies` P50 prio, `keyboard-walk` merge-conflict 45 %, `hairball` burnout 45 % | title-cat-whisperer 3, prop-parcel 1 |

**AI.** Category weights (attack / status / self):
- aggressive 70 / 20 / 10
- tricky 45 / 40 / 15
- tank 55 / 15 / 30

Weights drop to 0 when a category is useless: status when the active hero already has a major status, a shield when
the enemy is already shielded, a buff when it is already buffed, a heal when its HP is above 60 %. The remaining
weights are renormalised. `r1 % total` picks the category. Within "attack", `r2 % 100 < 60` picks the highest
`power × effect` move, else `r2` picks uniformly. Enemies ignore focus.

**Scaling.**
- `enemyLevel = clamp(round(avgPartyLevel × difficulty) + spread, 1, maxLevel + 5)`, where spread =
  `rngNext(seedState(seed, 0x5bd1e995)).value % 4 − 1` (−1..+2).
- `avgPartyLevel` (F13): a temporary (anonymous) member counts at most at the highest hero level in the party (its own
  level when the party has no hero), so a high-usage anonymous agent cannot inflate the enemy level to carry heroes.
- Enemy stats use the hero formulas with the table's B.
- Enemy HP × `enemyHpPct(n) = 150 + 40·(n−1)` % (n = party size). More heroes means more bench HP, so the enemy
  gets a matching HP pool.

**Worked example** (L10, neutral matchup, developer vs guest):
- `hotfix` hits for about 12–15. `commit` hits for about 8–10.
- The guest has 35 × 150 % = 52 HP: 4 hits with skills, 6 with basics.
- The guest's basic hits for ~7 and it attacks ~45 % of turns, so a 32-HP developer lasts about 9 turns before
  coffee.
- Expected: about 5 turns, a win with ~40 % HP left.
- A type-advantaged party roughly halves the turns; a disadvantaged one (developer vs monster) loses without a swap.
  That is intended.

### 4.7 Outcome

| result | XP per hero | tally | KO | loot |
|---|---|---|---|---|
| won | `battleXp(min(enemyLevel, heroLevel + 5), levelBase, xpScale, fainted)` = 1500·L·0.5 (about ¼ of a level at any L); half for heroes that fainted; the cap `heroLevel + 5` per hero (F13) stops an anonymous carry from farming XP for low heroes; then clamped (`maxXpPerUpdate`, `maxXp`; F2) | wins++, +1 bonus point when `wins % skillPointEveryWins === 0` | fainted heroes: `koUntil = now + koMinutes·60000` | loot stream (`seedState(lootSeed, 0x27d4eb2f)`, F4) draw `% 1000 < lootChance·1000` → recipient = a living hero (else any hero) by draw → weighted pick over the enemy's table, restricted to loot the recipient doesn't own; none left → no loot |
| lost | 0 | losses++ | every hero | — |
| fled / timeout | 0 | flees++ | fainted heroes | — |
| abandoned / expired (no resolve) | 0 | — (honour system, F11) | — | — |

`koMinutes = 0` means no KO. `skillPointsGained = (levelAfter − levelBefore) · skillPointsPerLevel + bonus`.
`heroLevel` is the hero's level before the battle (`levelForXp(core.xp)`).

---

## 5. Tasks

Sizing per `packages/agent-templates/skills/task-sizing` (10–20 min, one role, file-disjoint within a wave).
Web paths are under `apps/web/src/`, server paths under `apps/server/src/`. Every developer runs the ROOT `pnpm
typecheck` and their package tests before handing off. Nobody edits the hot files (invariant 7), `CHANGELOG.md`,
`ROADMAP.md` or `docs/`. A STUB keeps its W0 signatures; the named later task owns its body.

### Wave 0 (contract; W0a ∥ W0s ∥ W0-S, then W0b ∥ W0c ∥ W0w, then W0d)

W0a and W0s are committed (`20d66e1`); the W0-S fixes to them (F1 settings bounds, F2 `PROGRESSION_LIMITS` + clamps,
F10 `maxLog` 220) are a follow-up patch on the same files, and the code blocks in 1.3/1.4 show the patched values.
`OutcomeInput.lootSeed` (F4) lives in `battle/setup.ts` and is W0b's.

| id | title | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|---|
| W0a | Shared progression contract (done; F1/F2/F10 patch) | developer | `packages/shared/src/progression.ts`, `packages/shared/src/battle/types.ts`, `packages/shared/src/heroes.ts`, `packages/shared/src/domain.ts`, `packages/shared/src/socket.ts`, `packages/shared/src/index.ts`, placeholders `packages/shared/src/progressionContent.ts`, `packages/shared/src/battle/engine.ts`, `packages/shared/src/battle/setup.ts`, tests `packages/shared/src/__tests__/progression.test.ts` | none | 1.1–1.3 and 1.5 verbatim; pure functions implemented. Tests: `classForRole` (every shipped role, unknown → adventurer, `__proto__`/`constructor` → adventurer); `xpFromUsage` weights, flooring, negative/NaN → 0, counters clamped to `maxCounter`, result ≤ `maxXp`; `levelForXp` exact boundaries (xpForLevel(L)−1 → L−1, xpForLevel(L) → L) for L 1..100 at exponents 1, 1.5, 2, 4, capped at maxLevel; `advanceUsageMark` (re-parse = 0 delta, smaller usage = 0, telescoping sums equal one big delta, fractional weights lose nothing, stored counters clamped, delta ≤ `maxXpPerUpdate`); `validateSkillAllocation` every code, `__proto__`/`constructor`/`toString` keys → `unknown-skill` and no prototype read; `lootGrant` total; every schema rejects unknown keys and `__proto__` skill keys; `BattleResolveSchema` rejects a log of `maxLog + 1`; existing hero fixtures still parse. ROOT typecheck + all tests green. |
| W0s | Settings contract (done; F1 patch) | developer | `packages/shared/src/settings.ts`, `features/settings/meta.ts`, `features/settings/meta.test.ts`, `config/office.yaml` | none | 1.4 verbatim (`maxPerHour` ≤ 120, `retentionDays` ≤ 365); `defaultSettings()` has every key; meta hints/steps; meta tests extended; server settings tests green; ROOT typecheck. |
| W0-S | Threat model (done) | security-engineer | none (findings in the handoff; folded into this doc as F1–F15) | none | Done: `.tagconn/work/handoffs/m14-threat-model.md`, all findings accepted. |
| W0c | Battle engine | developer | `packages/shared/src/battle/rng.ts`, `packages/shared/src/battle/engine.ts`, `packages/shared/src/battle/__tests__/engine.test.ts`, `packages/shared/src/battle/__tests__/rng.test.ts`, `packages/shared/src/battle/__tests__/fixtures.ts` | W0a | 1.6 implemented; fixtures build setups by hand (no content dependency); tests per 6.1; no `Math.random`/`Date`/`Math.pow` in `battle/` (a grep test). |
| W0b | Content + setup + outcome | developer | `packages/shared/src/progressionContent.ts`, `packages/shared/src/battle/setup.ts`, `packages/shared/src/__tests__/content.test.ts`, `packages/shared/src/battle/__tests__/setup.test.ts` | W0a | 1.7 + section 4 tables. Content test: 8 classes × 12 nodes, prerequisite chain per template, every move id referenced exists, ≤ 8 moves per fully skilled hero, every enemy has 4 moves and ≥ 1 loot entry, every `LOOT_IDS` entry drops somewhere, every MoveDef field present. Setup tests: `statsFor` table values, `enemyLevelFor` range, `buildBattleSetup` deterministic per seed, temporary members capped at the highest hero level in `avgPartyLevel` (F13), `computeOutcome` rows of 4.7 incl. the `heroLevel + 5` XP cap and the XP clamps, loot depends on `lootSeed` (same setup/log, different `lootSeed` → loot can differ; same `lootSeed` → identical), `progressView` refund on class change and overspent flag, `skillsForClass`/`combatModsFor` ignore `__proto__`/`constructor` keys and return null-prototype records. |
| W0w | Web contract + stubs | developer (frontend) | `game/battle/types.ts`, `features/battle/types.ts`, `features/battle/encounterBus.ts`, `features/battle/__tests__/encounterBus.test.ts`, `stores/progressStore.ts`, `stores/progressStore.test.ts`, `game/sfxBus.ts`, `game/sfxBus.test.ts`, `lib/audio/presets.ts` (blank battle entries only), STUBS `game/battle/controller.ts`, `game/scenes/BattleScene.ts`, `features/battle/labels.ts`, `features/battle/commands.ts` | W0a; **the in-flight UI-sound task must have landed** (it owns `sfxBus.ts`/`presets.ts` until then) | 3.2 verbatim. Adds to `SFX_IDS`/`SFX_CATEGORY`: `battle-encounter` (alerts); `battle-text` (ui); `battle-swirl`, `battle-sting`, `battle-return`, `battle-hit`, `battle-hit-super`, `battle-hit-weak`, `battle-crit`, `battle-miss`, `battle-heal`, `battle-buff`, `battle-shield`, `battle-status`, `battle-faint`, `battle-enemy-faint`, `battle-swap`, `battle-item`, `battle-run`, `battle-victory`, `battle-defeat`, `battle-level-up`, `battle-loot`, `battle-xp-tick` (sfx). `SFX_CATEGORY` stays total. Blank presets keep the presets test green. Stores and bus tested. ROOT typecheck + web tests. |
| W0d | Balance simulation | developer | `packages/shared/src/battle/__tests__/balance.test.ts`; may change numeric constants only in `progressionContent.ts` and `enemyHpPct`/`battleXp` in `setup.ts` | W0b, W0c | A greedy bot (best affordable expected-damage move, coffee below 35 % HP, forced swaps to the healthiest member) over 300 seeds per cell. Neutral matchups at L5/15/30, difficulty 1: median turns in [4, 8]; win rate in [0.55, 0.9] for a party of 1 and [0.7, 0.98] for 2–4. Difficulty 2 win rate < difficulty 1. Timeouts < 1 %. Runs in < 5 s (else `*.perf.test.ts`). Section 4 numbers updated in the handoff if tuned. |

### Wave 1 (parallel)

| id | title | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|---|
| S1 | Server storage + module skeleton | developer (server) | `modules/progression/{progression.tables,progression.repository,battles.repository,progression.schema,index}.ts`, STUBS `modules/progression/{progression.service,progression.routes,battles.service,battles.routes}.ts`, `modules/progression/__tests__/repository.test.ts`, `core/db/migrations.ts`, `core/event-bus/event-bus.ts`, `core/realtime/index.ts`, `modules/snapshot/snapshot.service.ts`, `modules/snapshot/index.ts`, `app.ts` | W0 | 2.1, 2.2, 2.6. Migration 12 (additive) applies on a fresh DB and on a v0.7 DB; tables match the Drizzle definitions (incl. `loot_seed`, `expires_at`, index (status, expires_at)); repository round-trips; `transition` changes exactly one row; `pruneOrphans` removes rows of deleted heroes; `upsertCore` for an unknown hero returns false and inserts nothing; `getCore` returns missing / corrupt / ok, drops a stored `__proto__` skill key on read without polluting `Object.prototype`, and dedupes/validates loot; `insert` refuses a setup > 32 KiB and reports a PK collision distinctly; `abandonOpenWithHeroes`, `expireOpenBefore` (uses `expires_at`), `stripBefore` (keeps outcome + log_hash), `pruneExcess` (keeps the newest N non-open rows, never open ones); `txImmediate` uses BEGIN IMMEDIATE; `listViews` joins heroes; the snapshot carries `progress`; `hero:progress` is broadcast; the server boots (fail-closed access check) with stub routes; ROOT typecheck + server tests. |
| G1 | Battle controller | developer | `game/battle/controller.ts`, `game/battle/__tests__/controller.test.ts` | W0 | 3.5 controller semantics, tested with a fake clock and fixture setups. |
| G2 | BattleScene + stage | developer (game) | `game/scenes/BattleScene.ts`, `game/battle/stageLayout.ts`, `game/battle/swirl.ts`, `game/battle/animations.ts`, `game/battle/__tests__/{stageLayout,swirl,animations}.test.ts` | W0 (codes against the controller interface and the art stubs; uses placeholder rectangles until A1 lands) | 3.5: `launchBattle` adds/starts the scene, the entry/return transitions with sounds on the tween's first frame, reduced-motion variants, three backdrops, animations per event table, `setInsets` relayout, `destroy` idempotent; pure modules tested (layout bounds at 375×667 and 1920×1080, swirl coverage reaches 100 % at t = 1, `animFor` total over event kinds, reduced = no motion steps). Works on canvas. |
| A1 | Enemy + FX + KO icon art | developer (art) | `game/battle/enemyArt.ts`, `game/battle/fxArt.ts`, `game/battle/__tests__/{enemyArt,fxArt}.test.ts`, `game/textures.ts`, `game/textures.test.ts` | W0 | `paintEnemyTexture(scene, kind, style)` + `paintEnemyCanvas(ctx, kind, style, scale)` (for the alert portrait) for all 6 kinds × 3 styles; `paintFxTextures(scene)` idempotent; `icon-ko` (2 frames) + `icon-bandage` ≤ 7×7 before outline; tests: every kind/style paints non-empty pixels within bounds, idempotent texture keys. |
| U1 | Battle HUD (DOM) | developer (frontend) | `features/battle/hud/{BattleHud,CommandMenu,BattleLog,ResultsPanel,Bar}.tsx`, `features/battle/hud/menuModel.ts`, `features/battle/hud/__tests__/menuModel.test.ts`, `features/battle/hud/__tests__/BattleHud.test.tsx` | W0 (fake controller) | 3.6: menu reducer fully tested (navigation, disabled moves, forced swap, item target, busy → skip, sfx ids); HUD test: aria roles/labels, live region gets lines, Esc never closes the battle, reduced motion has no typewriter; results panel for every result incl. level-up and loot. |
| C1 | Labels, copy, durations | developer | `features/battle/labels.ts`, `features/battle/content/{modern,guild,rift}.ts`, `features/battle/copy.ts`, `features/battle/durations.ts`, `features/battle/__tests__/{labels,copy,durations}.test.ts` | W0 | 3.7 and its test. |
| AU1 | Battle audio | developer (audio) | `lib/audio/presets.ts`, `lib/audio/music.ts`, `lib/audio/engine.ts`, `lib/audio/types.ts`, `game/sfxBus.ts`, `features/office/audio/useAudioBridge.ts`, `lib/audio/__tests__/{presets,music,engine}.test.ts`, `game/sfxBus.test.ts` | W0w | Real presets for every battle id (swirl riser ≈ 0.65 s, return whoosh ≈ 0.3 s, sting ≤ 0.2 s, fanfares ≤ 1.5 s, hits ≤ 0.25 s, text blip ≤ 0.03 s). `sfxBus.setMusic(m: { kind: 'battle'; style: BattleStyle } \| null)` + `onMusic` (replayed to late subscribers). `music.ts` is a looping 4-bar chiptune sequencer per style (square lead, triangle bass, noise hats), deterministic, `stop(fadeMs)`. `AudioEngine.setMusic(kind \| null, fadeMs)` ducks the ambient bed to 30 % while music plays. The bridge plays music only when `settings.battle.music && master > 0`. Tests with a fake AudioContext. |
| H1 | Hero sheet Stats & Skills | developer (frontend) | `features/heroes/HeroEditor.tsx`, `features/heroes/stats/{HeroStatsSheet,SkillTreeView,StatsTable}.tsx`, `features/heroes/stats/skillPlan.ts`, `features/heroes/stats/__tests__/skillPlan.test.ts` | W0 (commands stub) | 3.8 sheet: tab bar, stats with planned deltas, tree with locks/reasons, save with `baseUpdatedAt`, respec rules, read-only without write access; `skillPlan` tested incl. "missing prerequisite rejected". |
| P1 | Data layer + demo progression | developer (frontend) | `lib/api.ts`, `lib/api.test.ts`, `lib/connection.ts`, `features/battle/commands.ts`, `features/battle/demoProgression.ts`, `features/battle/__tests__/demoProgression.test.ts` | W0 | 3.9 P1: live → REST, demo → local; demo battle create/resolve uses `buildBattleSetup` + `replay` + `computeOutcome` with its own stored `lootSeed`; demo XP from mock usage without double-count across reloads; bad storage never throws; connection seeds/broadcasts progress. |
| HB1 | HUD level badge + hooks | developer (frontend) | `features/office/hud/PortraitChip.tsx`, `features/battle/useProgress.ts`, `features/battle/__tests__/useProgress.test.ts` | W0 | 3.8 badge (hero, anonymous "~N", KO icons, aria-label); hooks tested (`useAgentLevel` null when disabled, `useNow` re-renders at koUntil). |

Hot files in Wave 1: `HeroEditor.tsx` → H1; `textures.ts` → A1; `sfxBus.ts`/`presets.ts`/`engine.ts` → AU1;
`PortraitChip.tsx` → HB1; `connection.ts`/`api.ts` → P1; `app.ts`, `migrations.ts`, `event-bus.ts`, `realtime/index.ts`,
`snapshot/*` → S1.

### Wave 2 (parallel)

| id | title | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|---|
| S2 | Progression service + routes | developer (server) | `modules/progression/progression.service.ts`, `modules/progression/progression.routes.ts`, `modules/progression/__tests__/progression.test.ts` | S1 | 2.3, 2.4 (progress rows, `bodyLimit` 16 384): XP credited from real transcript fixtures through `TranscriptsService` (`apps/server/test/fixtures/`); tests per 6.2 including the W0-S security tests S2-1..S2-10 (6.2, "Security (W0-S), S2"): counters near/above MAX_SAFE_INTEGER clamped with xp ≤ `maxXp`; forked-session fixture documents the re-count; a hero moved by a project merge is still credited; takeover deletes the old agent entry and old-agent usage credits nobody; a merge-deleted hero gets no orphan row; a corrupt skills JSON row is neither overwritten nor credited; a stored `__proto__` skill key is dropped on read with no pollution; `__proto__`/`constructor`/`toString` keys and > 48-key bodies → 400; unowned title → 409, non-title loot id → 400; skills/title/heal without a token → 401, progression disabled → skills 409. Plus: skill/title/heal routes with every error code; 429 after `WRITE_LIMIT`; `hero.removed` deletes progress; the heroes-before-progression listener order is asserted. |
| S3 | Battles service + routes + security tests | developer (server) | `modules/progression/battles.service.ts`, `modules/progression/battles.routes.ts`, `modules/progression/__tests__/battles.test.ts`, `core/http/__tests__/security.test.ts` | S1 | 2.4, 2.5 (`bodyLimit` 16 384, resolve 32 768; BEGIN IMMEDIATE; `lootSeed`; stored `expiresAt`; engine-version check; single re-read on a lost race; housekeeping order; PK collision retry; limiter counts only successful creates; stripped row → GET 410): tests per 6.3 and 6.4 (the security cases go into `security.test.ts`, also covering S2's routes by HTTP only), including the W0-S security tests S3-1..S3-16 (6.3, "Security (W0-S), S3"): no `lootSeed` in GET/create responses and loot not reproducible from the public setup + turns; two concurrent resolves → one award, identical repeat → same outcome with progress unchanged, the race path re-reads once; a version-mismatched setup → 409 + abandoned, no award; lowering `openTtlMin` after create doesn't expire early; body over the route `bodyLimit` → 413, log over `maxLog` → 400 before replay (spy); create with a hero in an open battle on another floor abandons it; housekeeping caps rows and strips old setup/log keeping the outcome; every new POST: foreign Origin 403, `text/plain` 415, no token 401, hook token alone 401; every new GET: foreign Host 403; unknown body keys incl. `seed`/`setup`/`lootSeed` on create → 400; malformed ids → 400 with no repository call; replay errors → 400 `{error, at}` with no change, `expect` mismatch → 409 with no change; abandon idempotent, resolve after abandon/expiry → 410; create past `maxPerHour` and writes past `WRITE_LIMIT` → 429, limiters not shared across `buildApp()`; error shape `{error, statusCode}` with no stack and the fail-closed boot check passes; `hero:progress` for project A never reaches a socket only in project B. |
| E1 | Encounter prompt in alerts | developer (frontend) | `features/office/alerts/{types,alertQueue,alertCopy,AlertBox,AlertHost,useAlertFeed}.ts(x)`, `features/office/alerts/__tests__/{alertQueue,alertCopy}.test.ts`, `features/battle/encounterRules.ts`, `features/battle/__tests__/encounterRules.test.ts` | W0w, A1 (`paintEnemyCanvas`) | 3.3: rules truth table tested (each condition alone blocks); queue: encounter never coalesces, uses tokens, ttl expiry reported in `expired`, `withdrawAlert`; existing alert tests still green; Battle/Ignore buttons labelled, no focus steal. |
| F1 | Battle flow + party picker + overlay | developer (frontend) | `features/battle/flowMachine.ts`, `features/battle/__tests__/flowMachine.test.ts`, `features/battle/useBattleFlow.ts`, `features/battle/party.ts`, `features/battle/__tests__/party.test.ts`, `features/battle/PartyPicker.tsx`, `features/battle/BattleOverlay.tsx` | G1, U1, C1, P1 | 3.3 NPC rules and 3.4/3.10 flow: reducer tested for every transition and effect (won → dismiss, others → release, withdraw before hold, waiting agent cancels, failed create → release + error, unmount mid-battle → abandon); `partyCandidates` tested (KO greyed, working tag, anonymous gated by setting, ordering); picker keyboard + sounds. |
| K1 | KO presence | developer (game) | `game/battle/koPresence.ts`, `game/battle/__tests__/koPresence.test.ts`, `game/actors/Character.ts` | A1 | 3.9 K1 truth table (resting/idle → dizzy, working → bandage, waiting → bandage, not KO / expired → null); `KoPresence.apply` only calls `setKoBadge` on change and never moves anything (fake Character spy); the badge never hides the waiting bubble. |
| L1 | Loot cosmetics | developer (frontend) | `features/heroes/HeroEditor.tsx`, `features/heroes/stats/HeroStatsSheet.tsx`, `features/heroes/stats/LootPanel.tsx`, `features/battle/lootTitle.ts`, `features/battle/__tests__/lootTitle.test.ts`, `game/heroLook.ts`, `game/heroLook.test.ts` (or the existing heroPreview test file if that is where `resolveHeroCostume` is tested) | H1, C1 | 3.9 L1: loot options only when owned; lootHat/lootProp override and clear; `plateTitle` precedence tested; title equip/unequip; portraits show loot hats. |
| T1 | Coffee-break heal trigger | developer (game) | `game/procgen/types.ts`, `game/furnitureTriggers.ts`, `game/furnitureTriggers.test.ts`, `game/procgen/triggers.ts`, `game/procgen/__tests__/triggers.test.ts`, `features/office/useFurnitureTriggers.ts` | P1 | 3.9 T1: infirmary marks an existing coffee machine / water cooler, is never placed, maps byte-identical for floors (existing procgen tests green), click heals KO'd floor heroes only with write access. |

### Wave 3

| id | title | role | owned files | depends on | acceptance criteria |
|---|---|---|---|---|---|
| W3-W | PM wiring | PM | `game/OfficeGame.ts`, `game/scenes/OfficeScene.ts`, `features/office/OfficeView.tsx` | all of Wave 2 | 3.10; ROOT typecheck/test/build, `test:perf`; smoke 6.8. |
| Gate | QA, review, security, docs | qa-engineer, code-reviewer, security-engineer, tech-writer (parallel) | qa: tests only; tech-writer: `docs/guide/battles.md` (new), `docs/guide/` heroes/settings/sound pages, `CHANGELOG.md` | W3-W | Plan's M14 verification list; security re-checks replay validation, the F1–F14 changes and the new routes against the `security.test.ts` patterns; guide covers prompts, party, controls, progression math, KO, loot, every setting, and the honour-system note (abandon/expire has no stakes). |

---

## 6. Test plan (vitest, pure first)

**6.1 Engine** (`engine.test.ts`, `rng.test.ts`)
- RNG golden values for seeds 0, 1, 2³²−1.
- **Determinism**: for 500 random seeds × random legal action sequences (picked by a seeded test rng from
  `legalActions`), `replay(setup, log)` is `toEqual` to the step-by-step `applyAction` fold, and to a second replay of
  a `JSON.parse(JSON.stringify(setup))` copy. Inputs are never mutated (deep-frozen inputs).
- **Golden**: one fixed setup and log produce an exact event list (snapshot). It changes only with `ENGINE_VERSION`.
- **Validation**:
  - every `BattleActionError` code is reachable;
  - actions after `end` are rejected;
  - a forced swap is required after a faint, consumes no turn and gets no enemy action;
  - out-of-range indices are rejected;
  - `replay` reports `at` for the first bad action;
  - a log that tampers with one action after the fact (a different move index) changes the outcome or fails.
- **Properties** (500 seeds each):
  - HP stays in [0, max] and focus in [0, max];
  - the engine ends within `maxTurns + 1` turns;
  - `ended` ⇔ `result !== null`;
  - item counts never go negative;
  - a fainted member never acts or is a target;
  - damage ≥ 1 on a hit;
  - the type chart is applied (super-effective damage ≥ neutral damage for the same draws, via fixtures).
- Status rules: stunned skips exactly one action; merge-conflict self-hit rate ≈ 33 % (±5 % over 2000 draws); burnout
  ticks; resist; durations in range; buff/shield cleared on swap.
- The longest legal log for `maxTurns` 200 and a party of 4 fits in `PROGRESSION_LIMITS.maxLog` (220).
- A grep test that `battle/*.ts` has no `Math.random`, `Date`, `performance` or `Math.pow`.

**6.2 XP crediting** (`progression.test.ts`, server)
- A bound hero is credited the weighted delta of a real fixture transcript, read through `TranscriptsService`.
- Re-reading the same file again gives no delta, and the same holds for a fresh read state (simulating `ensure()` with a
  new path state) and after an app restart on the same DB.
- An `agent.upserted` with unchanged usage makes no DB write (spy).
- An anonymous agent's usage advances the mark only. If the agent gets a hero later, only the usage after binding is
  credited.
- A takeover (reuse `takenFrom`) stops crediting the old agent.
- A released hero still gets the final SubagentStop read.
- Agent-id collisions across sessions or projects are not cross-credited.
- `progression.enabled = false` credits nothing but advances marks.
- A weight change only affects later deltas.
- Level/skillPoints in the emitted `hero:progress` match `progressView`.
- The heroes module's `agent.upserted` listener runs before progression's (a binding made on the same upsert is credited).

**Security (W0-S), S2** (`progression.test.ts`):
1. Counters near and above `Number.MAX_SAFE_INTEGER` are clamped (`maxCounter`); stored xp ≤ `maxXp`; one update adds
   ≤ `maxXpPerUpdate`; the zod view still parses.
2. A forked-session fixture (a new session whose transcript copies earlier history) documents the re-count of the
   copied part (F3, expected behaviour, asserted so a change is noticed).
3. After a runtime project merge (`project.merged`), the moved hero is still credited on its new floor.
4. A takeover deletes the old agent's cache entry; the old agent's later usage credits nobody.
5. A hero deleted by a merge (raw SQL, no `hero.removed`) gets no orphan `hero_progress` row from later usage.
6. A row with corrupt skills JSON is neither overwritten nor credited (warning logged); skills/title/heal answer 409.
7. A stored `__proto__` skill key is dropped on read; `Object.prototype` is not polluted.
8. `__proto__` / `constructor` / `toString` skill keys and bodies with > 48 keys → 400.
9. An unowned title → 409; a non-title loot id → 400.
10. Skills/title/heal without a token → 401; `progression.enabled = false` → skills 409.

**6.3 Battles** (`battles.test.ts`, server)
- create: every validation error code; a KO'd hero gets 409; maxParty; an anonymous agent with/without the setting; an
  agent that has a hero gets 400; a second create abandons the first; the seed is not client-controlled (an extra body
  field is 400); a PK collision retries once.
- resolve:
  - a valid win awards XP, level, bonus point and loot exactly once;
  - repeating the same log returns the same outcome with no second award (progress unchanged), also after the row was
    stripped;
  - a different log afterwards → 409;
  - two concurrent resolves (`Promise.all` of `inject`) → one award;
  - a tampered or illegal log → 400 with `at`;
  - an unfinished log → 400;
  - an `expect` mismatch → 409 with no change;
  - an expired battle → 410; an abandoned one → 410;
  - a hero deleted mid-battle is skipped;
  - a loss KOs everyone, and `koUntil` blocks a new battle until then; heal clears it.
- GET of a stripped row → 410.
- A full scripted battle (party of 2, win → level up, loot) through REST, mirroring the plan's smoke.

**Security (W0-S), S3** (`battles.test.ts` and `security.test.ts`):
1. No `lootSeed` in the create or GET responses; the loot is not reproducible from the public setup + turns (two rows
   with the same setup and log but different stored `lootSeed` can differ).
2. Two concurrent resolves → one award; an identical repeat → the same outcome with progress unchanged; the lost-race
   path re-reads once (spy on `get`) and never replays twice.
3. A version-mismatched stored setup → 409 `engine version changed`, row abandoned, no award, replay not called.
4. Lowering `openTtlMin` after create does not expire the battle early (stored `expires_at`).
5. A body over the route `bodyLimit` → 413; a log over `maxLog` → 400 before replay (spy on `replay`).
6. Create with a hero that is in an open battle on another floor abandons that battle.
7. Housekeeping caps rows at `maxStoredBattles` and strips old setup/log while keeping the outcome and `log_hash`.
8. Every new POST: foreign Origin → 403, `text/plain` → 415, no token → 401, the hook token alone → 401.
9. Every new GET: foreign Host → 403.
10. Unknown body keys, incl. `seed` / `setup` / `lootSeed` on create → 400.
11. Malformed hero/battle ids → 400 with no repository call (spy).
12. Replay errors → 400 `{error, at}` with no state change; an `expect` mismatch → 409 with no state change.
13. Abandon is idempotent; resolve after abandon or expiry → 410.
14. Create past `maxPerHour` and writes past `WRITE_LIMIT` → 429; rejected creates don't count; limiters are not
    shared across `buildApp()` instances.
15. The error shape is `{error, statusCode}` with no stack; the fail-closed boot check passes.
16. `hero:progress` for project A never reaches a socket subscribed only to project B.

**6.4 Security** (additions to `core/http/__tests__/security.test.ts`)
- Foreign `Origin` → 403 on every new POST; foreign `Host` → 403 on the GETs.
- `text/plain` → 415.
- No admin token → 401 on every write (the hook token alone too), while the public GETs stay 200 without a token.
- Strict bodies: unknown keys → 400, `__proto__` / `constructor` / `toString` skill keys → 400 (locks in F14), a log
  over `maxLog` (220) → 400, out-of-range action indices → 400, bodies over `bodyLimit` → 413.
- Malformed hero/battle ids → 400 before DB access (spy on the repository).
- Rate limits: create past `maxPerHour` → 429, writes past `WRITE_LIMIT` → 429. Each app instance has its own limiter.
- The error shape is `{ error, statusCode }` with no stack. The fail-closed boot check still passes.
- (These overlap the S3 list above by design: `security.test.ts` holds the HTTP-guard cases for every new route.)

**6.5 Shared content and setup**: section 5 W0b/W0d criteria.

**6.6 Web pure modules**:
- the controller (G1);
- `menuModel` (U1);
- `stageLayout` / `swirl` / `animations` (G2);
- labels / copy / durations (C1);
- `encounterRules` + alertQueue additions (E1);
- `flowMachine` + `party` (F1);
- `koPresence` (K1);
- `skillPlan` (H1);
- `lootTitle` / heroLook (L1);
- `demoProgression` (P1): the client engine's outcome for a fixed seed, `lootSeed` and log equals the server's
  `computeOutcome(replay(...))`; the golden passes `lootSeed` explicitly. This is the plan's "replay matches across
  client and server": the same shared code imported by both, asserted on a golden.
- `progressStore` / `encounterBus` (W0w).

**6.7 Audio** (AU1): presets durations; music deterministic; ducking; music gated by `battle.music` and master.

**6.8 PM smoke** (`?demo=1` and a sandboxed live server; modern, guild, rift; desktop and 375×667)
- Lower `npcs.encounterEverySec` and set `battle.offerChance = 1`. An encounter shows "A wild … appeared!" and the NPC
  holds at its step.
- Ignore → the NPC carries on and the chaos reaction runs.
- With an agent waiting, no prompt appears, and an open one is withdrawn.
- Battle → pick 2 (one working, one anonymous) → the swirl with its sound → fight with keyboard only, then with mouse
  only → win → results with level-up and loot → the return transition → the NPC leaves.
- Lose a battle: KO'd heroes show 💫 in the lounge, a working KO'd hero shows 🩹 and keeps its seat (the plan's "a
  KO'd working hero is never moved").
- Coffee machine click → healed.
- Hero sheet: allocate and save; a missing prerequisite is refused; respec.
- The HUD level badge updates when usage arrives (live: a sandboxed `claude -p` run per CLAUDE.md).
- Reduced motion (OS setting): sting instead of swirl, no typewriter.
- Canvas renderer forced locally.
- Music plays and stops, and mute works.

---

## 7. Trade-offs

- **Setup carries full move/item definitions.** Stored setups are a few KB bigger (capped at 32 KiB, stripped 24 h
  after the battle ends), but content changes or server upgrades can never make an open battle replay differently.
  Only engine-rule changes need `ENGINE_VERSION` (an old open battle then gets 409 `engine version changed` and is
  abandoned before any replay).
- **The client knows the battle seed; the loot seed is server-only (F4).** A player could search for the best moves
  offline. That is just playing well. The stakes are cosmetic and rate-limited, and the server still validates every
  action. Hiding the battle seed would need server-side turn-by-turn play (a round trip per turn) for no real gain. The
  loot roll, however, uses a separate `lootSeed` that never leaves the server, so a client cannot choose a log (turn
  count) that yields a particular loot item.
- **Cross-engine determinism is fail-safe.** The server trusts only the action log and its own replay; if client and
  server engines ever diverge, the result is a 409 desync with nothing awarded, never a wrong award.
- **Abandon on new create** (one open battle per floor and per hero). Two tabs can each get an encounter (NPCs are
  simulated per tab); the second create silently abandons the first, whose resolve gets 410. This is simpler than
  cross-tab locking and fair (no stakes are lost or doubled). The same rule across floors (`abandonOpenWithHeroes`)
  keeps a hero moved by a merge out of two open battles.
- **Loss stakes are honour-system (F11).** Abandoning or letting a battle expire records nothing (no loss, no KO, no
  flee). A player can dodge a loss by closing the tab. Accepted: the stakes are cosmetic. A possible follow-up is
  `flees++` on abandon/expire; M14 does not do it.
- **Client-chosen `npcKind` and `encounterId`.** The server cannot know which NPC a tab simulated, so a client may
  pick its opponent (and thus its loot table). `battle.maxPerHour` (≤ 120) is the only bound; accepted as cosmetic.
- **Component-wise high-water marks** never over-count per (sessionId, agentId), but under-count usage below an old
  peak after a rare transcript file switch. Marks are never pruned (tiny rows), because a resumed session can re-read
  any old transcript.
- **Forked/resumed sessions can re-count copied history (F3).** A fork gets a new session id and starts from zero
  marks; if its transcript contains the parent's earlier messages, that usage is credited again. Detecting copied
  history would need cross-session message-id tracking; accepted because XP is cosmetic. Documented by an S2 test.
- **Hard XP clamps (F2).** Counters are clamped to 1e13, XP to 1e12 and one update to 5M XP. Real usage never reaches
  them; forged or corrupt usage can't overflow safe integers or break the zod `.int()` view. An over-cap delta is
  dropped (the mark advances), never re-credited later.
- **Level is derived on read** from XP and the current curve settings. Tuning `levelBase` re-levels everyone at once.
  An allocation that becomes overspent is kept, shown as "overspent", and may always be reduced.
- **Corrupt rows are kept, not repaired (F14).** A `hero_progress` row that fails to parse is logged and skipped
  (no credit, writes answer 409) instead of being overwritten with an empty core, so a parser bug can never silently
  wipe progress.
- **Bounded battle history (F1).** Battles are deleted after `retentionDays` (≤ 365) and capped at 2000 stored rows;
  resolved rows keep their setup/log only 24 h. After that an identical repeat is still answered by `log_hash`, but the
  battle can no longer be re-inspected via GET (410).
- **DOM HUD + Phaser stage** instead of an all-Phaser battle screen. Accessibility (focus, aria-live, real buttons),
  the shared typewriter/JRPG frame, RTL-testable menus and file-disjoint parallel work outweigh the cost of keeping
  two layers in sync. One controller timeline drives both, so they cannot drift.
- **Loot ownership is enforced by the UI only** for appearance. `lootHat`/`lootProp` are plain appearance fields. An
  admin could set them through `PATCH /api/heroes/:id` without owning them. That is harmless (cosmetic, admin-only),
  and avoids coupling the heroes module to progression. The title, which lives in progression, is checked server-side.
- **No server timers for KO.** `koUntil` is just a timestamp from the server clock, checked on create and rendered by
  clients. Clock skew between browser and server only shifts the cosmetic icon.
- **Auth parity.** Battle/skill/title/heal writes are `admin` like hero edits; the reads follow the existing public
  read policy; the `progression`/`battle` settings follow `auth.protect` like every other section (F12).
- **Sockets.** `hero:progress` goes to `rooms.all` + the hero's project room, with `projectId` from the heroes join;
  nothing is emitted when the hero is gone. No client→server events were added.
- **Storage and migration.** All SQL goes through Drizzle / prepared statements; migration 12 is additive. The battle
  create limiter counts only successful creates; a battle id PRIMARY KEY collision (48 random bits) retries once.
- **Encounter prompts ride the alert queue** (tokens, `alerts.enabled`). Battles never spam on top of real alerts, and
  real asks always outrank them. The cost: turning alerts off also turns off battle prompts (documented in the guide).
- **Admin-gated battles** (parity with hero edits). An unpaired browser gets no prompts instead of a broken Battle
  button. Demo mode needs no pairing.
