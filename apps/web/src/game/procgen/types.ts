// apps/web/src/game/procgen/types.ts  (owned by 7c; created FIRST, verbatim, so 7d can code against it)
//
// See docs/design/guild-hall.md section 4. This file is type-only (no Phaser, no runtime code) so
// 7d (themes) can import it the moment it lands. `generateMap` and `generateRandomLayout` are
// declared in generate.ts and bsp.ts respectively and re-exported from index.ts.
import type { DoorSide, DoorSpec, LayoutIssue, RoomType, Zone } from '@tagconn/shared';

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export type TileKind = 'void' | 'floor' | 'wall' | 'door';
export type FurnitureKind =
  | 'work-desk'
  | 'lead-desk'
  | 'table'
  | 'board'
  | 'workbench'
  | 'booth'
  | 'rack'
  | 'shelf'
  | 'sofa'
  | 'armchair'
  | 'rug'
  | 'mat'
  | 'counter'
  | 'plant'
  | 'centerpiece'
  | 'pedestal'
  | 'sigil'
  | 'stairs-up'
  | 'stairs-down'
  // M8 8n (furnishing engine): new kinds so rooms scale/fill by density instead of leaving empty floor.
  | 'rack-row'
  | 'console'
  | 'lab-bench'
  | 'equipment'
  | 'shelf-stack'
  | 'reading-table'
  | 'standing-table'
  | 'reception-desk'
  | 'bench'
  | 'lamp'
  | 'crate'
  | 'wall-art'
  | 'bin'
  | 'cabinet'
  | 'chair'
  | 'banner'
  // M8 8p: standing appliances, always against a north wall (docs/design/back-wall.md).
  | 'printer'
  | 'fridge'
  | 'water-cooler'
  | 'filing-cabinet'
  | 'coffee-machine'
  | 'bookcase'
  | 'fireplace'
  | 'coat-rack'
  | 'supply-stack'
  | 'cage';
export interface PlacedFurniture extends Rect {
  kind: FurnitureKind;
  blocking: boolean;
  roomId: string;
  roomType: RoomType;
  variant: number;
  /** M8 8p: true when y === room.interior.y and every tile directly north of the footprint is a wall.
   *  Only then may a painter draw above the footprint (at most MAX_OVERDRAW_PX). Omitted = false. */
  againstNorthWall?: boolean;
}
export interface Seat extends Point {
  zone: Zone;
  roomId: string;
  kind: 'sit' | 'stand';
}
export interface Door extends Point {
  roomId: string;
  to: string | 'hall';
  vertical: boolean;
  /** Wall side and position in `room.doors` terms (n/s/e/w + offset + width), so the editor can
   *  materialize an auto door into an explicit `LayoutRoom.doors` entry. `width` is always resolved
   *  (undefined in `DoorSpec` means 1). */
  side: DoorSide;
  offset: number;
  width: number;
  /** true when the layout left `room.doors` undefined and this door was placed automatically. */
  auto: boolean;
}
export interface StairsSpot extends Point {
  dir: 'up' | 'down';
  roomId: string;
  /** walkable tile in front, for hover/tooltips */
  landing: Point;
}
export interface DecorSlot extends Point {
  kind: 'wall-light' | 'wall-hanging' | 'floor-scatter';
  roomId: string | null;
  variant: number;
}
/** M8 8p: semantic wall-mounted decor on a north-wall face (style-agnostic, D2). */
export type WallDecorKind = 'window' | 'clock' | 'picture' | 'board' | 'chart' | 'wall-shelf' | 'banner';
export interface WallDecorSlot {
  kind: WallDecorKind;
  /** Left-most wall tile; `y` is the WALL row (room.interior.y - 1). */
  x: number;
  y: number;
  /** Width in tiles, 1-3 (see WALL_DECOR_SPANS). */
  span: number;
  roomId: string;
  variant: number;
}
export interface GeneratedRoom {
  id: string;
  type: RoomType;
  name?: string;
  footprint: Rect;
  interior: Rect;
  walled: boolean;
  seats: Seat[];
  tiles: Point[];
  labelAt: Point;
}
export interface ZoneInfo {
  zone: Zone;
  rect: Rect;
  walled: boolean;
  seats: Seat[];
  tiles: Point[];
} // same shape seats.ts uses today
/** Why a room (other than stairs/hall, same as the `unreachable-room` issue) can't be reached from spawn. */
export type UnreachableReason = 'sealed' | 'blocked-by-furniture' | 'no-corridor';
export interface UnreachableRoom {
  roomId: string;
  reason: UnreachableReason;
  /** A door that would connect it, when one can be suggested. */
  suggestion?: DoorSpec;
}
/** BFS-from-spawn summary (M8 8n): additive alongside the `unreachable-room`/`unreachable-seat`
 *  `issues` entries, with a reason and a fix suggestion per room. */
export interface ReachabilityReport {
  unreachableRooms: UnreachableRoom[];
  unreachableSeats: number;
}
export interface GeneratedMap {
  layoutId: string;
  seed: number;
  cols: number;
  rows: number;
  tileSize: number;
  tiles: TileKind[][]; // [y][x]
  walkable: number[][]; // [y][x] 0 = walkable, 1 = blocked (easystar)
  walls: boolean[][]; // tiles === 'wall'
  roomAt: (string | null)[][]; // room id for floor tiles; null = hall/corridor
  zoneAt: (Zone | null)[][];
  rooms: GeneratedRoom[];
  zones: Record<Zone, ZoneInfo>; // every zone present; missing ones alias their resolveZone() target
  furniture: PlacedFurniture[];
  doors: Door[];
  stairs: StairsSpot[];
  decor: DecorSlot[];
  /** M8 8p: static wall decor, baked into the base texture. North-wall LIGHTS are not here: they are
   *  emitted as ordinary `decor` `wall-light` slots, so torch sprites and 8o bloom pick them up unchanged. */
  northWall: WallDecorSlot[];
  spawn: Point; // inside the entrance
  frontDoor: Point | null; // outer-wall gate tile (visual only)
  issues: LayoutIssue[]; // generation issues (validateLayout issues are included too)
  reachability: ReachabilityReport;
}
