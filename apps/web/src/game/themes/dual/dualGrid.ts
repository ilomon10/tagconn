// apps/web/src/game/themes/dual/dualGrid.ts  (M15 dual grid, see docs/design/dual-grid.md)
//
// The offset "dual" grid: (cols+1) x (rows+1) cells centred on the tile corners of the map grid.
// Each cell samples the kind of its four surrounding tiles (quadrants) so edge, corner and cliff
// art can be drawn where per-tile paint cannot see a neighbour. Pure TS, no Phaser.
//
// W0 contract: types, constants and the trivial pure helpers. `makeKindAt`, `buildDualCells` and
// `isUniform` are implemented in W1 (D0) together with `dualGeom.ts`.
import type { RoomType } from '@tagconn/shared';
import type { GeneratedMap, TileKind } from '../../procgen/types';

/** What a quadrant of a dual cell samples: off-map and `void` tiles are `void`; door tiles count as `floor`. */
export type CornerKind = 'void' | 'wall' | 'floor';
/** Floor kind of a quadrant: the room type of the tile, or `corridor` for hall/corridor floor. */
export type FloorKind = RoomType | 'corridor';
/** The four tiles around a cell's centre (the tile corner at `(cx, cy)`). */
export type Quadrant = 'tl' | 'tr' | 'bl' | 'br';
export const QUADRANTS: readonly Quadrant[] = ['tl', 'tr', 'bl', 'br'];
/** Mask bit per quadrant: `mask = tl<<3 | tr<<2 | bl<<1 | br`. */
export const BIT: Record<Quadrant, number> = { tl: 8, tr: 4, bl: 2, br: 1 };

export interface DualCell {
  /** Cell coordinates: the map tile corner it is centred on, 0..cols / 0..rows. */
  cx: number;
  cy: number;
  kinds: Record<Quadrant, CornerKind>;
  /** 4-bit masks over `BIT`: which quadrants are wall / floor (doors included) / void / door. */
  wallMask: number;
  floorMask: number;
  voidMask: number;
  doorMask: number;
  /** Floor kind per quadrant; null for wall and void quadrants. */
  floorKinds: Record<Quadrant, FloorKind | null>;
  /** Room id per quadrant (`map.roomAt`); null for hall/corridor, wall and void quadrants. */
  roomIds: Record<Quadrant, string | null>;
}

/** The map tile a quadrant samples: tl=(cx-1,cy-1), tr=(cx,cy-1), bl=(cx-1,cy), br=(cx,cy). May be off-map. */
export function quadrantTile(cell: Pick<DualCell, 'cx' | 'cy'>, q: Quadrant): { x: number; y: number } {
  const x = q === 'tl' || q === 'bl' ? cell.cx - 1 : cell.cx;
  const y = q === 'tl' || q === 'tr' ? cell.cy - 1 : cell.cy;
  return { x, y };
}

/** Top-left pixel of a cell: it is centred on the tile corner, so it starts half a tile up and left of it. */
export function cellOrigin(cell: Pick<DualCell, 'cx' | 'cy'>, T: number): { px: number; py: number } {
  return { px: cell.cx * T - T / 2, py: cell.cy * T - T / 2 };
}

/** Pixel rect (T/2 x T/2) of one quadrant of a cell. */
export function quadrantRect(cell: Pick<DualCell, 'cx' | 'cy'>, q: Quadrant, T: number): { x: number; y: number; w: number; h: number } {
  const { px, py } = cellOrigin(cell, T);
  const half = T / 2;
  const x = q === 'tl' || q === 'bl' ? px : px + half;
  const y = q === 'tl' || q === 'tr' ? py : py + half;
  return { x, y, w: half, h: half };
}

/** The corner kind of a map tile: off-map (`undefined`) and `void` are void; `door` counts as floor. */
export function cornerKind(tile: TileKind | undefined): CornerKind {
  if (tile === undefined || tile === 'void') return 'void';
  if (tile === 'wall') return 'wall';
  return 'floor';
}

/** Floor kind lookup for a map: the room type of the tile, or `corridor` outside rooms. W1. */
export function makeKindAt(_map: GeneratedMap): (x: number, y: number) => FloorKind {
  throw new Error('not implemented');
}

/** Builds all (cols+1)*(rows+1) cells, indexed `cy * (cols + 1) + cx`. W1. */
export function buildDualCells(_map: GeneratedMap, _kindAt?: (x: number, y: number) => FloorKind): DualCell[] {
  throw new Error('not implemented');
}

/** True when all four quadrants share one corner kind (and floor kind): the cell draws nothing. W1. */
export function isUniform(_cell: DualCell): boolean {
  throw new Error('not implemented');
}
