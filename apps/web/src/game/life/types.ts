import type { Agent, Settings } from '@tagconn/shared';
import type { ActorKey } from '../cast';
import type { Character } from '../actors/Character';
import type { CosmeticClaimsApi } from '../cosmetic/types';
import type { PathFinder } from '../pathfinding';
import type { GeneratedMap, PlacedFurniture, Point } from '../procgen/types';
import type { SeatAllocator } from '../seats';
import type { SfxEvent } from '../sfxBus';
import type { LifeActivity, MeetingLines, ThemeDefinition } from '../themes/types';

export type LifeSettings = Settings['office']['life'];

export interface LifeHost {
  map(): GeneratedMap;
  finder(): PathFinder;
  seats(): SeatAllocator;
  /** Cast characters only (never the Receptionist or NPCs). */
  actors(): ReadonlyMap<ActorKey, Character>;
  agents(): readonly Agent[];
  themeFor(c: Character): ThemeDefinition;
  office(): Settings['office'] | undefined;
  floorKey(): string;
  reducedMotion(): boolean;
  lowQuality(): boolean;
  claims(): CosmeticClaimsApi;
  keyForAgent(agentId: string): ActorKey | undefined;
  /** Multiverse: the room ids of `c`'s realm; null on a normal floor. */
  realmRooms(c: Character): ReadonlySet<string> | null;
}

export type LifeScriptKind = 'kickoff' | 'standup' | 'activity';
/** host = meeting host (may be `delegating`); invitee = kickoff subagent (idle|thinking, no tool); idle = everyone else. */
export type LifeRole = 'host' | 'invitee' | 'idle';

export interface LifeScript {
  readonly id: string;
  readonly kind: LifeScriptKind;
  /** Current participants (shrinks on revoke/break-off). */
  readonly keys: readonly ActorKey[];
  /** Advance on the director's 500 ms tick; 'done' once every claim is released. */
  step(now: number): 'running' | 'done';
  /** `key`'s claim was taken by a higher priority: forget it without moving it (clear emote/pose/bubble only). */
  revoke(key: ActorKey, now: number): void;
  /** Flags turned off: everyone not walking elsewhere goes home; claims are released by the following steps. */
  cancel(now: number): void;
  /** reset(): drop at once, no walking (the scene is about to teleport/destroy); releases every claim. */
  abort(): void;
}

export interface LifeCtx {
  host: LifeHost;
  /** Live, not gone. */
  char(key: ActorKey): Character | undefined;
  /** Live eligibility for a role (section 3.2.2). */
  eligible(key: ActorKey, role: LifeRole): boolean;
  goHome(c: Character): void;
  /** `sayDrama` when `office.showBubbles`. */
  say(c: Character, line: string, sec: number): void;
  sfx(e: SfxEvent): void;
  rng(seed: string): () => number;
  /** Free for a spot: walkable, no seat occupant, not reserved, nobody standing, clear of waiting characters. */
  isFree(p: Point): boolean;
  /** Tiles that are `sit` seats (sit pose on arrival). */
  isSitTile(p: Point): boolean;
}

export interface Venue {
  roomId: string;
  /** null = lounge fallback with no table (gather around the room centre). */
  table: PlacedFurniture | null;
  /** Ring spots; [0] is the host's. Reserved by the meeting. */
  spots: Point[];
}
export interface MeetingPlan {
  id: string;
  kind: 'kickoff' | 'standup';
  hostKey: ActorKey;
  inviteeKeys: ActorKey[];
  /** One seeded invitee who dawdles (null with < 2 invitees). */
  stragglerKey: ActorKey | null;
  venue: Venue;
  lines: MeetingLines;
  meetingMs: number;
  seed: string;
}
export interface ActivityPlan {
  id: string;
  activity: LifeActivity;
  keys: ActorKey[];
  prop: PlacedFurniture | null;
  spots: Point[];
  durationMs: number;
  seed: string;
}
export type StartMeeting = (ctx: LifeCtx, plan: MeetingPlan, now: number) => LifeScript | null;
export type StartActivity = (ctx: LifeCtx, plan: ActivityPlan, now: number) => LifeScript | null;

/** Internal timeouts (ms), not user thresholds. */
export const LIFE_TIMING = {
  step: 500, inviteEmote: 2000, convene: 12_000, fetch: 10_000, lineEvery: 3500, lineSec: 3, replyDelay: 1800, return: 20_000,
} as const;
