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
