// apps/web/src/game/procgen/types.ts  (owned by 7c; created FIRST, verbatim, so 7d can code against it)
//
// See docs/design/guild-hall.md section 4. This file is type-only (no Phaser, no runtime code) so
// 7d (themes) can import it the moment it lands. `generateMap` and `generateRandomLayout` are
// declared in generate.ts and bsp.ts respectively and re-exported from index.ts.
import type { LayoutIssue, RoomType, Zone } from '@tagconn/shared';

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
  | 'stairs-down';
export interface PlacedFurniture extends Rect {
  kind: FurnitureKind;
  blocking: boolean;
  roomId: string;
  roomType: RoomType;
  variant: number;
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
  spawn: Point; // inside the entrance
  frontDoor: Point | null; // outer-wall gate tile (visual only)
  issues: LayoutIssue[]; // generation issues (validateLayout issues are included too)
}
