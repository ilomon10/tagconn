import type { Agent, NpcKind, RoomType, Settings } from '@tagconn/shared';
import type { ActorKey } from '../cast';
import type { Character } from '../actors/Character';
import type { CosmeticClaimsApi } from '../cosmetic/types';
import type { PathFinder } from '../pathfinding';
import type { FurnitureKind, GeneratedMap, Point } from '../procgen/types';
import type { SeatAllocator } from '../seats';
import type { SfxEvent, SfxId } from '../sfxBus';
import type { CreatureId, LifePose, ThemeDefinition } from '../themes/types';

export type { NpcKind };
export type NpcSettings = Settings['office']['npcs'];
export const creatureTextureKey = (id: CreatureId, frame: 0 | 1): string => `creature-${id}-${frame}`;
export const SHADES_TEXTURE = 'npc-shades';

/** 24 weights, index = host hour 0..23. */
export type HourCurve = readonly number[];
export type ReactionKind = 'flee' | 'gather' | 'chase';
export type NpcTarget =
  | { furniture: readonly FurnitureKind[] }
  | { rooms: readonly RoomType[] }
  | 'corridor' | 'entrance' | 'crowd';
export type NpcStep =
  | { do: 'enter' }
  | { do: 'goto'; target: NpcTarget }
  | { do: 'wander'; rooms: number }
  | { do: 'sweep'; tiles: number }
  | { do: 'bit'; pose: LifePose; sec: readonly [number, number]; line?: boolean; react?: ReactionKind; sfx?: SfxId }
  | { do: 'exit' };
export interface EncounterDef {
  kind: NpcKind;
  /** Routine kinds still come with `npcs.encounters` off. The janitor is scheduled by `janitorDue`, not by weight. */
  routine: boolean;
  weight: number;
  hours: HourCurve;
  steps: readonly NpcStep[];
}

/** M14 hook: OfficeGame forwards these as the 'encounter' event. */
export interface EncounterEvent {
  id: string;
  kind: NpcKind;
  style: ThemeDefinition['id'];
  name: string;
  phase: 'appeared' | 'bit' | 'left';
  at: number;
}

export interface NpcHost {
  map(): GeneratedMap;
  finder(): PathFinder;
  seats(): SeatAllocator;
  /** Cast characters (reactors), never NPCs or the Receptionist. */
  actors(): ReadonlyMap<ActorKey, Character>;
  agents(): readonly Agent[];
  theme(): ThemeDefinition;
  office(): Settings['office'] | undefined;
  floorKey(): string;
  reducedMotion(): boolean;
  lowQuality(): boolean;
  isMultiverse(): boolean;
  /** Host clock hour 0..23 (M15 replaces the source). */
  hour(): number;
  claims(): CosmeticClaimsApi;
  /** Creates a Character at `at` (tile) with hover handlers and the current hit scale. */
  spawnNpc(key: ActorKey, at: Point): Character;
  emit(e: EncounterEvent): void;
}

export interface NpcActor {
  id: string;
  key: ActorKey; // `npc:<kind>:<seq>`
  kind: NpcKind;
  def: EncounterDef;
  char: Character;
  stepIndex: number;
  stepAt: number;
  /** M14: paused by hold(); the runner idles without advancing. */
  held: boolean;
  /** Runner scratch state for the current step. */
  scratch: Record<string, unknown>;
}

export interface NpcScriptCtx {
  host: NpcHost;
  rng(seed: string): () => number;
  say(c: Character, line: string, sec: number): void;
  sfx(e: SfxEvent): void;
  /** Tiles of waiting/blocked cast characters this tick. */
  waitingTiles(): readonly Point[];
  /** Starts a reaction when chaos is allowed (no-op otherwise). */
  react(npc: NpcActor, kind: ReactionKind, now: number): void;
  emit(npc: NpcActor, phase: EncounterEvent['phase'], now: number): void;
}
export interface NpcScriptRunner {
  /** 'done' once the NPC is gone (faded out after exit). */
  step(npc: NpcActor, now: number): 'running' | 'done';
}
export type CreateScriptRunner = (ctx: NpcScriptCtx) => NpcScriptRunner;

export interface ReactionController {
  /** Returns how many characters react. */
  start(npc: NpcActor, kind: ReactionKind, now: number): number;
  step(now: number): void;
  /** Everyone goes home (sendHome) or is dropped in place; claims released. */
  cancelAll(sendHome: boolean): void;
  activeKeys(): ReadonlySet<ActorKey>;
}
export type CreateReactions = (host: NpcHost, rng: (seed: string) => () => number) => ReactionController;

export const NPC_TIMING = {
  step: 500, stepTimeout: 25_000, scriptMax: 120_000, reactMin: 3000, reactSpan: 5000, chaseRepath: 1000,
  janitorCooldown: 600_000, sweepPause: 600,
} as const;
