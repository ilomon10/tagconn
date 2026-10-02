// apps/web/src/game/themes/dual/dualGrid.ts  (M15 dual grid, see docs/design/dual-grid.md)
//
// The offset "dual" grid: (cols+1) x (rows+1) cells centred on the tile corners of the map grid.
// Each cell samples the kind of its four surrounding tiles (quadrants) so edge, corner and cliff
// art can be drawn where per-tile paint cannot see a neighbour. Pure TS, no Phaser.
//
// Geometry only (guild-hall.md D2): a cell reads `tiles` / `roomAt` / room types and never a theme, so
// the masks are identical for every style. The 16-case shape lookup lives in `dualGeom.ts`.
import type { RoomType } from '@tagconn/shared';
import type { GeneratedMap, Point, TileKind } from '../../procgen/types';

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

export type KindAt = (x: number, y: number) => CornerKind;
export type FloorKindAt = (x: number, y: number) => FloorKind;

/** `tiles[y][x]` → corner kind: off-map and `void` are `void`, `door` is `floor`. */
export function makeKindAt(map: Pick<GeneratedMap, 'tiles'>): KindAt {
  return (x, y) => cornerKind(map.tiles[y]?.[x]);
}

/** Same rule as `renderTheme.ts` `kindAt`: the room type by `roomAt`, else `corridor` when the layout has void,
 *  else `hall`. Only meaningful on floor/door tiles (the dual cell stores null for wall and void quadrants). */
export function makeFloorKindAt(map: Pick<GeneratedMap, 'tiles' | 'rooms' | 'roomAt'>): FloorKindAt {
  const hasVoid = map.tiles.some((row) => row.includes('void'));
  const openFloorKind: FloorKind = hasVoid ? 'corridor' : 'hall';
  const roomTypeById = new Map(map.rooms.map((r) => [r.id, r.type] as const));
  return (x, y) => {
    const id = map.roomAt[y]?.[x];
    return id ? (roomTypeById.get(id) ?? 'hall') : openFloorKind;
  };
}

/** The four corner kinds around the tile corner `(cx, cy)`, sampled through `kindAt`. */
export function cornerKinds(kindAt: KindAt, cx: number, cy: number): Record<Quadrant, CornerKind> {
  const at = (q: Quadrant): CornerKind => {
    const t: Point = quadrantTile({ cx, cy }, q);
    return kindAt(t.x, t.y);
  };
  return { tl: at('tl'), tr: at('tr'), bl: at('bl'), br: at('br') };
}

/** Mask of the quadrants whose kind is `kind`. */
export function maskOf(kinds: Record<Quadrant, CornerKind>, kind: CornerKind): number {
  let mask = 0;
  for (const q of QUADRANTS) if (kinds[q] === kind) mask |= BIT[q];
  return mask;
}

/** One cell: its four kinds, the masks that partition `0xf`, and the floor kind / room id per quadrant.
 *  Hot at 128 x 96 (12.5k cells per bake, D4 perf budget): the quadrant tiles are indexed inline rather than through
 *  `quadrantTile`/`cornerKinds`/`maskOf`, so a cell costs four small objects, not a dozen. Same result as those helpers. */
export function buildDualCell(
  map: Pick<GeneratedMap, 'tiles' | 'roomAt'>,
  cx: number,
  cy: number,
  kindAt: KindAt,
  floorKindAt: FloorKindAt,
): DualCell {
  const kinds: Record<Quadrant, CornerKind> = { tl: 'void', tr: 'void', bl: 'void', br: 'void' };
  const floorKinds: Record<Quadrant, FloorKind | null> = { tl: null, tr: null, bl: null, br: null };
  const roomIds: Record<Quadrant, string | null> = { tl: null, tr: null, bl: null, br: null };
  let wallMask = 0;
  let floorMask = 0;
  let voidMask = 0;
  let doorMask = 0;
  // QUADRANTS is tl, tr, bl, br: bit 0 of the index picks the east column, bit 1 the south row (see `quadrantTile`).
  for (let i = 0; i < 4; i++) {
    const q = QUADRANTS[i]!;
    const x = i & 1 ? cx : cx - 1;
    const y = i & 2 ? cy : cy - 1;
    const kind = kindAt(x, y);
    const bit = BIT[q];
    kinds[q] = kind;
    if (kind === 'wall') wallMask |= bit;
    else if (kind === 'void') voidMask |= bit;
    else {
      floorMask |= bit;
      if (map.tiles[y]?.[x] === 'door') doorMask |= bit;
      floorKinds[q] = floorKindAt(x, y);
      roomIds[q] = map.roomAt[y]?.[x] ?? null;
    }
  }
  return { cx, cy, kinds, wallMask, floorMask, voidMask, doorMask, floorKinds, roomIds };
}

/** Every cell, row-major (cy outer, cx inner): `(cols + 1) * (rows + 1)` entries, index `cy * (cols + 1) + cx`. */
export function buildDualCells(map: Pick<GeneratedMap, 'cols' | 'rows' | 'tiles' | 'rooms' | 'roomAt'>): DualCell[] {
  const kindAt = makeKindAt(map);
  const floorKindAt = makeFloorKindAt(map);
  const cells: DualCell[] = [];
  for (let cy = 0; cy <= map.rows; cy++) {
    for (let cx = 0; cx <= map.cols; cx++) cells.push(buildDualCell(map, cx, cy, kindAt, floorKindAt));
  }
  return cells;
}

/** All four quadrants the same kind (door counts as floor): the painters draw nothing on such a cell. */
export function isUniform(cell: Pick<DualCell, 'wallMask' | 'floorMask' | 'voidMask'>): boolean {
  return cell.wallMask === 0xf || cell.floorMask === 0xf || cell.voidMask === 0xf;
}

/** Bits of the face quadrants (back-wall.md): wall `tl` over floor/door `bl` (bit 8), wall `tr` over floor/door `br`
 *  (bit 4). Those pixels belong to the back-wall face; the dual painters never touch them. */
export function faceMask(cell: Pick<DualCell, 'wallMask' | 'floorMask'>): number {
  let mask = 0;
  if (cell.wallMask & BIT.tl && cell.floorMask & BIT.bl) mask |= BIT.tl;
  if (cell.wallMask & BIT.tr && cell.floorMask & BIT.br) mask |= BIT.tr;
  return mask;
}
