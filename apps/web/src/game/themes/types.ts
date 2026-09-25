// apps/web/src/game/themes/types.ts  (owned by 7d, see docs/design/guild-hall.md section 3)
//
// The theme contract: geometry (procgen) never depends on style, so switching skins never moves
// characters or seats (D2). A theme only paints. Two implementations exist: `modern.ts` (a straight
// port of the pre-M7 office art) and `guild.ts` (the magic guild hall).
import type { Activity, OfficeStyle, RoomType, Zone } from '@tagconn/shared';
import type * as Phaser from 'phaser';
import type { DecorSlot, GeneratedMap, PlacedFurniture } from '../procgen/types';

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
  hat?: 'none' | 'wizard' | 'hood' | 'crown' | 'helm' | 'bard-cap' | 'circlet';
  hatColor?: number;
  staff?: 'none' | 'staff' | 'wand' | 'hammer' | 'quill' | 'lute' | 'shield';
  trim?: number;
  /** Additive detail not in the original sketch: a pair of goggles pushed up on the forehead. */
  goggles?: boolean;
}

export interface ThemeDefinition {
  id: OfficeStyle;
  palette: Palette;
  /** Paint one floor or corridor tile into the base texture. `rand` is seeded per tile. */
  paintFloor(g: Phaser.GameObjects.Graphics, kind: RoomType | 'corridor', px: number, py: number, rand: () => number): void;
  paintWall(g: Phaser.GameObjects.Graphics, px: number, py: number, faceVisible: boolean, rand: () => number): void;
  paintVoid(g: Phaser.GameObjects.Graphics, px: number, py: number, rand: () => number): void;
  /**
   * A door tile: the floor under it plus a threshold. Not in the original section-3 sketch (which
   * had no per-tile door hook) — added because `GeneratedMap.tiles` has a `door` tile kind that
   * needs *some* themed paint. `wide` is true for the 2-tile front gate.
   */
  paintDoor(g: Phaser.GameObjects.Graphics, kind: RoomType | 'corridor', px: number, py: number, wide: boolean, rand: () => number): void;
  /** Static furniture art per semantic kind (drawn into the base texture). */
  paintFurniture(g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number): void;
  /** Animated objects (torch flames, cauldron bubbles, portal swirl). Returns objects to destroy on rebuild. */
  animate(scene: Phaser.Scene, map: GeneratedMap, opts: { ambient: boolean }): Phaser.GameObjects.GameObject[];
  decorFor(slot: DecorSlot): string | null; // texture key for a wall or floor decoration
  zoneNames: Record<Zone, string>;
  roomNames: Record<RoomType, string>;
  roleTitles: Record<string, string>; // by role name; unknown roles keep role.title
  costumes: Record<string, Costume>; // by role name; `default` key for unknown roles
  activityVerbs: Partial<Record<Activity, string>>; // bubble text when the server bubble is generic
  /** Activity effects (particles) attached to a character. */
  activityFx?: Partial<Record<Activity, 'sparkles' | 'bubbles' | 'rune' | 'channel' | 'none'>>;
  lighting: { dayTint: number; nightTint: number; nightAlpha: number; glowAtNight: boolean };
  floorLabel(index: number, projectName: string): string;
}
