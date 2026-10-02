// apps/web/src/game/themes/types.ts  (owned by 7d, see docs/design/guild-hall.md section 3)
//
// The theme contract: geometry (procgen) never depends on style, so switching skins never moves
// characters or seats (D2). A theme only paints. Two implementations exist: `modern.ts` (a straight
// port of the pre-M7 office art) and `guild.ts` (the magic guild hall).
import type { Activity, MULTIVERSE_THEME_ID, NpcKind, OfficeStyle, RoomType, Zone } from '@tagconn/shared';
import type * as Phaser from 'phaser';
import type { SfxId } from '../sfxBus';
import type { DecorSlot, FurnitureKind, GeneratedMap, PlacedFurniture, WallDecorSlot } from '../procgen/types';
import type { DualCell } from './dual/dualGrid';

/** Particle effects on a character. M12 adds `streak` (on a roll). Used by ThemeDefinition, fx.ts and Character.ts. */
export type ActivityFxKind = 'sparkles' | 'bubbles' | 'rune' | 'channel' | 'streak' | 'none';

/** M12 G1 work strain, in display priority order (dizzy wins). */
export type StrainKind = 'dizzy' | 'sweating' | 'tired' | 'on-a-roll';
export const STRAIN_PRIORITY: readonly StrainKind[] = ['dizzy', 'sweating', 'tired', 'on-a-roll'];

/** M12 G1 icon shown over a character during an idle antic. M13 adds life/NPC emotes. */
export type DramaEmote =
  | 'mug' | 'note' | 'dice' | 'ball' | 'phone' | 'laugh' | 'spark' | 'zz'
  | 'megaphone' | 'alarm' | 'heart' | 'gamepad' | 'paddle' | 'chess' | 'can' | 'pencil' | 'broom' | 'parcel';

export interface DramaAntic {
  /** kebab-case, unique within one theme's list. */
  id: string;
  /** The cast gathers next to ONE of these (the first kind present in the room wins). `[]` = acts in place. */
  props: readonly FurnitureKind[];
  /** 1 = solo, 2 = needs a partner in the same room. */
  cast: 1 | 2;
  emote?: DramaEmote;
  /** One exchange is picked per run: `[a]` for solo antics, `[a, b]` (b = the partner's reply) for pairs. Each line <= 48 chars. */
  lines: readonly (readonly [string] | readonly [string, string])[];
}

export interface DramaContent {
  antics: readonly DramaAntic[];
  /** One line is said (lowest bubble priority) when a strain starts. Each line <= 48 chars. */
  strain: Record<StrainKind, readonly string[]>;
}

/** M13: a cosmetic body pose (Character.setPose). Overrides the activity animation while standing still. */
export type LifePose = 'chat' | 'sip' | 'play' | 'cheer' | 'stretch' | 'phone' | 'water' | 'nap' | 'doodle' | 'sweep' | 'carry' | 'sit';

export interface LifeActivity {
  /** kebab-case, unique within one theme's list. */
  id: string;
  /** Any-of furniture kinds to gather at (nearest item on the floor/realm). `[]` = in place (allowed under reduced motion). */
  requires: readonly FurnitureKind[];
  /** [min, max] cast size. */
  cast: readonly [1 | 2 | 3 | 4, 1 | 2 | 3 | 4];
  /** Relative pick weight (> 0). */
  weight: number;
  /** Seeded within [min, max] seconds. */
  durationSec: readonly [number, number];
  pose: LifePose;
  emote?: DramaEmote;
  /** Said by seeded cast members, one every LIFE_TIMING.lineEvery. Each line <= 48 chars. */
  lines: readonly string[];
}

/** Line pools for one meeting type. Each line <= 48 chars. */
export interface MeetingLines {
  invite: readonly string[]; // host, at the start ("Kickoff in the war room!")
  fetch: readonly string[]; // host, to the straggler
  dawdle: readonly string[]; // straggler's reply
  talk: readonly string[]; // during the meeting, any participant
  close: readonly string[]; // host, at the end
}

export interface LifeContent {
  activities: readonly LifeActivity[];
  kickoff: MeetingLines;
  standup: MeetingLines;
}

/** Non-human NPC bodies (Character.setCreature). Texture keys: `creature-<id>-0|1` (npc/types.ts). */
export type CreatureId = 'dog' | 'cat' | 'monster' | 'wolf' | 'familiar' | 'slime' | 'hover-hound' | 'astro-cat' | 'void-blob';

export interface NpcSkin {
  /** Plate line 1, e.g. "Sales Dog" / "Town Guard". */
  name: string;
  /** Plate line 2, e.g. "Visitor". */
  title?: string;
  /** Plate name colour and body tint. */
  color: number;
  /** Human NPCs: costume overlays (hat, staff prop, shades, robe tint). */
  costume?: Costume;
  /** Non-human NPCs: replaces the whole body. */
  creature?: CreatureId;
  /** Said during the NPC's bit. Each line <= 48 chars. */
  lines: readonly string[];
  /** Bit sound (bark, meow, whistle...). */
  sound?: SfxId;
  /** Which `npc-jingle-N` plays on entry. */
  jingle: 0 | 1 | 2 | 3;
}

export interface NpcContent {
  skins: Record<NpcKind, NpcSkin>;
}

export interface Palette {
  bg: number;
  floorBase: Record<RoomType | 'corridor', number>;
  floorAccent: Record<RoomType | 'corridor', number>;
  wallTop: number;
  wallFace: number;
  wallEdge: number;
  void: number;
  text: string;
  labelBg: string;
  transition: number;
}

export interface Costume {
  robe?: number;
  cloak?: number;
  hat?: 'none' | 'wizard' | 'hood' | 'crown' | 'helm' | 'bard-cap' | 'circlet' | 'cap' | 'police-cap' | 'fedora' | 'hardhat';
  hatColor?: number;
  staff?: 'none' | 'staff' | 'wand' | 'hammer' | 'quill' | 'lute' | 'shield' | 'mop' | 'parcel' | 'watering-can' | 'clipboard';
  trim?: number;
  /** Additive detail not in the original sketch: a pair of goggles pushed up on the forehead. */
  goggles?: boolean;
  /** M13: dark glasses (CIA agent, inquisitor); drawn by Character from SHADES_TEXTURE. */
  shades?: boolean;
}

/** M8 8p: per-theme back-wall face numbers (docs/design/back-wall.md section 1). */
export interface BackWallStyle {
  capPx: number;
  bandPx: number;
}
export interface BackWallCtx {
  kind: RoomType | 'corridor'; // floor kind of the tile below (palette hook)
  band: boolean; // tile below is floor (false under a door)
  openLeft: boolean; // left neighbour is not a face tile (door, side wall, void): draw a jamb/edge
  openRight: boolean;
  capPx: number;
  bandPx: number;
}

/** M15 dual grid: one offset cell handed to `paintDualFloor` / `paintDualWall` (docs/design/dual-grid.md). */
export interface DualCtx {
  cell: DualCell;
  /** Top-left pixel of the cell (`cellOrigin`): half a tile up and left of the tile corner. Never pass it to `tileOf`. */
  px: number;
  py: number;
  T: number;
  /** The theme's back-wall numbers (`backWall`, 0 when absent): the cap outline lives in the top `capPx`. */
  capPx: number;
  bandPx: number;
  /** True on the second call, after the back-wall faces: only face-adjacent art (the cap outline) may draw then. */
  facePass: boolean;
}

export interface ThemeDefinition {
  /** Widened for the Multiverse's web-only `rift` theme (M8 8h), which is never a user-selectable
   *  `OfficeStyle` — see `MULTIVERSE_THEME_ID` and `game/themes/rift.ts`. */
  id: OfficeStyle | typeof MULTIVERSE_THEME_ID;
  palette: Palette;
  /** Paint one floor or corridor tile into the base texture. `rand` is seeded per tile. */
  paintFloor(g: Phaser.GameObjects.Graphics, kind: RoomType | 'corridor', px: number, py: number, rand: () => number): void;
  paintWall(g: Phaser.GameObjects.Graphics, px: number, py: number, faceVisible: boolean, rand: () => number): void;
  paintVoid(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void;
  /**
   * M15 dual grid: the wall top WITHOUT the per-tile edge line (the dual pass draws the outline). Used
   * instead of `paintWall` when `office.dualGrid` is on. MUST consume the same `rand()` draws as
   * `paintWall`, so the per-tile seed stream stays identical for everything painted after it.
   */
  paintWallBase?(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void;
  /** M15: edge/corner/cliff art of one dual cell over floor quadrants. Uniform cells draw nothing. */
  paintDualFloor?(g: Phaser.GameObjects.Graphics, ctx: DualCtx, rand: () => number): void;
  /** M15: wall-cap outline and rounded corners of one dual cell. Never paints a face quadrant (wall with floor/door south). */
  paintDualWall?(g: Phaser.GameObjects.Graphics, ctx: DualCtx, rand: () => number): void;
  /** M8 8p: per-theme back-wall face numbers (docs/design/back-wall.md). Optional so rift/tests
   *  compile until painted; a theme without it renders exactly as before (no tall face). */
  backWall?: BackWallStyle;
  /** Paint the tall face for a face tile: wall tile from capPx down, plus (ctx.band) the top bandPx of
   *  the tile below, baseboard at the bottom. Called AFTER all tiles, so it overdraws the floor row. */
  paintBackWall?(g: Phaser.GameObjects.Graphics, px: number, py: number, ctx: BackWallCtx, rand: () => number): void;
  /** Static wall decor baked into the base texture. `faceTop`/`faceBottom` are absolute px of the face. */
  paintWallDecor?(g: Phaser.GameObjects.Graphics, slot: WallDecorSlot, T: number, face: { top: number; bottom: number }): void;
  /**
   * A door tile: the floor under it plus a threshold. Not in the original section-3 sketch (which
   * had no per-tile door hook) — added because `GeneratedMap.tiles` has a `door` tile kind that
   * needs *some* themed paint. `wide` is true for the 2-tile front gate.
   */
  paintDoor(g: Phaser.GameObjects.Graphics, kind: RoomType | 'corridor', px: number, py: number, wide: boolean, rand: () => number): void;
  /** Static furniture art per semantic kind (drawn into the base texture). */
  paintFurniture(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number): void;
  /**
   * Animated objects (torch flames, cauldron bubbles, portal swirl). Returns objects to destroy on
   * rebuild. `motes` and `budget` are Multiverse-only (M8 8h): the scene calls each realm's theme
   * with `motes: false` (no duplicate starfield per realm) and calls `rift` once for the whole map
   * with the global motes and its share of `office.multiverseMaxCharacters`'s ambient sibling,
   * `MULTIVERSE_LIMITS.maxAmbientObjects`. A theme that ignores them (guild, modern) is unaffected.
   */
  animate(scene: Phaser.Scene, map: GeneratedMap, opts: { ambient: boolean; motes?: boolean; budget?: number }): Phaser.GameObjects.GameObject[];
  decorFor(slot: DecorSlot): string | null; // texture key for a wall or floor decoration
  /**
   * Multiverse-only (M8 8h): paints a floating-island rock underside on a `void` tile 1 or 2 rows
   * below a themed region's bottom-most floor/wall row (`depth`), so each realm reads as an island
   * adrift in the rift's starfield. Only `rift.ts` implements this; `renderGeneratedMap` calls it
   * (if present) on the base theme for the tiles just below every region — see `renderTheme.ts`.
   */
  paintIslandEdge?(g: Phaser.GameObjects.Graphics, px: number, py: number, depth: 1 | 2, rand: () => number): void;
  zoneNames: Record<Zone, string>;
  roomNames: Record<RoomType, string>;
  roleTitles: Record<string, string>; // by role name; unknown roles keep role.title
  costumes: Record<string, Costume>; // by role name; `default` key for unknown roles
  activityVerbs: Partial<Record<Activity, string>>; // bubble text when the server bubble is generic
  /** Activity effects (particles) attached to a character. */
  activityFx?: Partial<Record<Activity, ActivityFxKind>>;
  /** M12 G1: idle antics + strain lines. Optional: a theme without it has no drama (rift reuses guild's). */
  drama?: DramaContent;
  /** M13: idle activities + meeting lines. */
  life?: LifeContent;
  /** M13: NPC skins per semantic kind. */
  npcs?: NpcContent;
  lighting: {
    dayTint: number;
    nightTint: number;
    /** The fallback overlay's max alpha. */
    nightAlpha: number;
    glowAtNight: boolean;
    /** M16 (docs/design/lighting.md section 2.2). Omitted fields fall back to LIGHTING_DEFAULTS[theme.id]. */
    /** Sky colour blended into the ambient at dawn (modern 0xffd9b0, guild 0xffc890, rift 0xd0b0ff). */
    dawnTint?: number;
    /** (modern 0xffb080, guild 0xff9a60, rift 0xb080ff) */
    duskTint?: number;
    /** Night ambient colour (modern 0x3a4a80, guild 0x4a3a80, rift 0x30206a). */
    moonTint?: number;
    /** Window shaft colour by day (modern 0xfff2c8, guild 0xffd89a, rift 0xa8f0ff). */
    sunColor?: number;
    /** Window shaft colour by night (modern 0x9ab0ff, guild 0xa090ff, rift 0x7ef0e8). */
    moonColor?: number;
    /** The procgen ceiling light's colour (modern 0xfff4dc cool-white, guild 0xffb060 chandelier amber, rift 0x9fd8ff). */
    roomLight?: number;
    /** 0..1 darkness of cast shadows (modern 0.22, guild 0.28, rift 0.2). */
    shadowAlpha?: number;
  };
  floorLabel(index: number, projectName: string): string;
}
