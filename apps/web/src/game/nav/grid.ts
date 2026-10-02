// apps/web/src/game/nav/grid.ts  (M15 T1, docs/design/navigation.md section 2.2)
//
// The sub-tile collision grid. One tile = SUB x SUB cells; a tile's walkable cells live in the low
// nibble of its `masks` byte (bit = `bitOf(cx, cy)`), tile flags in the high nibble. `clearance` is the
// true clearance per cell (HAA*): `clearance[c] >= k` iff the k x k block anchored top-left at `c` is
// free. Pure TS, no Phaser: `generate.ts` builds it (`buildNavGrid`) and derives `walkable` from it.
import type { GeneratedMap, PlacedFurniture, Point, Rect } from '../procgen/types';
import { CELL_PX, CLEARANCE_MAX, FULL_MASK, SUB, SUB_SHIFT, TILE_FLAG_DOOR, TILE_FLAG_FLOOR, TILE_FLAG_SOFT, TILE_FLAGS, TILE_PX } from './constants';
import { blockedCells, KIND_SHAPE, type NavShape } from './shapes';
import type { CellRect, NavGrid } from './types';

export type { CellRect, NavGrid } from './types';

export const tileIndex = (g: Pick<NavGrid, 'cols'>, x: number, y: number): number => y * g.cols + x;
export const cellIndex = (g: Pick<NavGrid, 'ccols'>, cx: number, cy: number): number => cy * g.ccols + cx;
/** Bit of cell (cx, cy) inside its tile's nibble: `(cy % SUB) * SUB + (cx % SUB)` (tl=0 tr=1 bl=2 br=3 for SUB=2). */
export const bitOf = (cx: number, cy: number): number => ((cy & (SUB - 1)) * SUB) | (cx & (SUB - 1));

/** A grid with every cell blocked and no flags. */
export function createNavGrid(cols: number, rows: number): NavGrid {
  const ccols = cols * SUB;
  const crows = rows * SUB;
  return { cols, rows, ccols, crows, masks: new Uint8Array(cols * rows), clearance: new Uint8Array(ccols * crows) };
}

/** False outside the grid. */
export function isWalkableCell(g: NavGrid, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= g.ccols || cy >= g.crows) return false;
  return ((g.masks[(cy >> SUB_SHIFT) * g.cols + (cx >> SUB_SHIFT)]! >> bitOf(cx, cy)) & 1) === 1;
}

/**
 * World px (nav point space). Hot path, no allocation: the tile first (an all-or-nothing nibble answers
 * without touching the cell), then the cell bit. False outside the map.
 */
export function isWalkableWorld(g: NavGrid, px: number, py: number): boolean {
  if (px < 0 || py < 0) return false;
  const tx = (px / TILE_PX) | 0;
  const ty = (py / TILE_PX) | 0;
  if (tx >= g.cols || ty >= g.rows) return false;
  const m = g.masks[ty * g.cols + tx]! & FULL_MASK;
  if (m === FULL_MASK) return true;
  if (m === 0) return false;
  return ((m >> bitOf((px / CELL_PX) | 0, (py / CELL_PX) | 0)) & 1) === 1;
}

/** Nibble === FULL_MASK: a person can stand here (today's `walkable === 0`). False outside. */
export function isTileStandable(g: NavGrid, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return false;
  return (g.masks[y * g.cols + x]! & FULL_MASK) === FULL_MASK;
}

/** Masks only; call `updateClearance` (or `computeClearance`) afterwards. No-op outside the grid. */
export function setCell(g: NavGrid, cx: number, cy: number, walkable: boolean): void {
  if (cx < 0 || cy < 0 || cx >= g.ccols || cy >= g.crows) return;
  const i = (cy >> SUB_SHIFT) * g.cols + (cx >> SUB_SHIFT);
  const bit = 1 << bitOf(cx, cy);
  if (walkable) g.masks[i] = g.masks[i]! | bit;
  else g.masks[i] = g.masks[i]! & ~bit;
}

/** ORs `flags` (high nibble only) into the tile. No-op outside the grid. */
export function setTileFlags(g: NavGrid, x: number, y: number, flags: number): void {
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return;
  const i = y * g.cols + x;
  g.masks[i] = g.masks[i]! | (flags & TILE_FLAGS);
}

/** The tile's flag nibble (0 outside the grid). */
export function tileFlags(g: NavGrid, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return 0;
  return g.masks[y * g.cols + x]! & TILE_FLAGS;
}

/** `clearance[cell] >= k` (false outside): a k x k block anchored (top-left) at the cell fits. */
export function fits(g: NavGrid, cx: number, cy: number, k: number): boolean {
  if (cx < 0 || cy < 0 || cx >= g.ccols || cy >= g.crows) return false;
  return g.clearance[cy * g.ccols + cx]! >= k;
}

/** Tile rect (positions multiples of 1/SUB) → cell rect. `Math.round` because `r.x * SUB` is exact for halves. */
export function cellRectOf(r: Rect): CellRect {
  return { x0: Math.round(r.x * SUB), y0: Math.round(r.y * SUB), x1: Math.round((r.x + r.w) * SUB), y1: Math.round((r.y + r.h) * SUB) };
}

/** Anchor (top-left cell) of a k x k block centred on nav point `p`: `round(p / CELL_PX - k / 2)`. */
export function anchorOfPoint(p: Point, k: number): Point {
  return { x: Math.round(p.x / CELL_PX - k / 2), y: Math.round(p.y / CELL_PX - k / 2) };
}

/** Centre nav point of a block anchored at `a`: `(a + k / 2) * CELL_PX`. */
export function pointOfAnchor(a: Point, k: number): Point {
  return { x: (a.x + k / 2) * CELL_PX, y: (a.y + k / 2) * CELL_PX };
}

/** Nav point of a tile for class size k (default SUB = a person): k = SUB is the tile centre, i.e. feet - FEET_DY. */
export function navPointOfTile(t: Point, k = SUB): Point {
  return pointOfAnchor({ x: t.x * SUB, y: t.y * SUB }, k);
}

/** The tile a nav point lies in: `floor(p / TILE_PX)`. */
export function tileOfNavPoint(p: Point): Point {
  return { x: Math.floor(p.x / TILE_PX), y: Math.floor(p.y / TILE_PX) };
}

/** Clips a cell rect to the grid; null when nothing is left. */
function clipCells(g: NavGrid, r: CellRect): CellRect | null {
  const c = { x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), x1: Math.min(g.ccols, r.x1), y1: Math.min(g.crows, r.y1) };
  return c.x0 < c.x1 && c.y0 < c.y1 ? c : null;
}

/**
 * Applies furniture to the masks. A blocking item (`item.blocking`; hall pins are placed non-blocking
 * whatever their kind) clears the cells `shapes[kind]` says it covers; a non-blocking item only sets
 * `TILE_FLAG_SOFT` on the tiles it touches. Returns the union of the cell rects that lost cells (the
 * dirty rect for `updateClearance`) or null when no blocking item touched the grid.
 */
export function applyFurniture(g: NavGrid, items: readonly PlacedFurniture[], shapes: Record<string, NavShape> = KIND_SHAPE): CellRect | null {
  let dirty: CellRect | null = null;
  for (const item of items) {
    const cells = clipCells(g, cellRectOf(item));
    if (!cells) continue;
    if (!item.blocking) {
      // Every tile the (possibly half-offset) footprint touches, i.e. `coveredTiles(item)`.
      const ty1 = (cells.y1 - 1) >> SUB_SHIFT;
      const tx1 = (cells.x1 - 1) >> SUB_SHIFT;
      for (let ty = cells.y0 >> SUB_SHIFT; ty <= ty1; ty++) for (let tx = cells.x0 >> SUB_SHIFT; tx <= tx1; tx++) setTileFlags(g, tx, ty, TILE_FLAG_SOFT);
      continue;
    }
    const shape = shapes[item.kind] ?? 'full';
    if (shape === 'none') continue;
    const blocked = blockedCells(shape, cells);
    for (let cy = cells.y0; cy < cells.y1; cy++) for (let cx = cells.x0; cx < cells.x1; cx++) if (blocked(cx, cy)) setCell(g, cx, cy, false);
    dirty = dirty
      ? { x0: Math.min(dirty.x0, cells.x0), y0: Math.min(dirty.y0, cells.y0), x1: Math.max(dirty.x1, cells.x1), y1: Math.max(dirty.y1, cells.y1) }
      : cells;
  }
  return dirty;
}

/**
 * Rasterizes `tiles` (floor/door → FULL + flags, wall/void → 0), applies `baseWalkable` when given (a tile
 * with 1 → 0 nibble; the pre-furniture grid of generate.ts, so stairs/landing blocks and anything else the
 * generator marks stay authoritative), then `applyFurniture`, then `computeClearance`.
 */
export function buildNavGrid(
  map: Pick<GeneratedMap, 'cols' | 'rows' | 'tiles' | 'furniture'>,
  baseWalkable?: readonly (readonly number[])[],
  shapes?: Record<string, NavShape>,
): NavGrid {
  const g = createNavGrid(map.cols, map.rows);
  for (let y = 0; y < map.rows; y++) {
    const row = map.tiles[y];
    const base = baseWalkable?.[y];
    for (let x = 0; x < map.cols; x++) {
      const t = row?.[x];
      if (t !== 'floor' && t !== 'door') continue;
      const open = base === undefined || base[x] === 0;
      g.masks[y * map.cols + x] = (open ? FULL_MASK : 0) | TILE_FLAG_FLOOR | (t === 'door' ? TILE_FLAG_DOOR : 0);
    }
  }
  applyFurniture(g, map.furniture, shapes);
  computeClearance(g);
  return g;
}

/** Adapter fallback for `number[][]` callers: each tile FULL (0) or 0 (1), floor flag on walkable tiles. */
export function navGridFromWalkable(walkable: readonly (readonly number[])[]): NavGrid {
  const rows = walkable.length;
  const cols = walkable[0]?.length ?? 0;
  const g = createNavGrid(cols, rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (walkable[y]![x] === 0) g.masks[y * cols + x] = FULL_MASK | TILE_FLAG_FLOOR;
  computeClearance(g);
  return g;
}

/** `[y][x] = isTileStandable ? 0 : 1`. */
export function walkableFromNav(g: NavGrid): number[][] {
  const out: number[][] = [];
  for (let y = 0; y < g.rows; y++) {
    const row: number[] = new Array<number>(g.cols);
    for (let x = 0; x < g.cols; x++) row[x] = (g.masks[y * g.cols + x]! & FULL_MASK) === FULL_MASK ? 0 : 1;
    out.push(row);
  }
  return out;
}

/**
 * True clearance of one cell from its right / down / diagonal neighbours (which must already be up to
 * date): a k x k block is the cell plus the three (k-1) x (k-1) blocks at (x+1, y), (x, y+1), (x+1, y+1),
 * so `c >= k` iff all three have `c >= k - 1`. Saturates at CLEARANCE_MAX.
 */
function clearanceAt(g: NavGrid, cx: number, cy: number): number {
  if (!isWalkableCell(g, cx, cy)) return 0;
  const i = cy * g.ccols + cx;
  const right = cx + 1 < g.ccols;
  const down = cy + 1 < g.crows;
  const r = right ? g.clearance[i + 1]! : 0;
  const d = down ? g.clearance[i + g.ccols]! : 0;
  const rd = right && down ? g.clearance[i + g.ccols + 1]! : 0;
  return Math.min(CLEARANCE_MAX, 1 + Math.min(r, d, rd));
}

/** One pass, bottom-right to top-left, O(cells). */
export function computeClearance(g: NavGrid): void {
  for (let cy = g.crows - 1; cy >= 0; cy--) for (let cx = g.ccols - 1; cx >= 0; cx--) g.clearance[cy * g.ccols + cx] = clearanceAt(g, cx, cy);
}

/**
 * Recomputes the dependency cone of `dirty`: a cell reads only cells to its right/below within
 * CLEARANCE_MAX - 1, so a change inside `dirty` can only alter clearances in `dirty` grown by that much
 * to the left and up. Cells right/below the grown rect are unchanged inputs; the rect is recomputed
 * bottom-right first, so every read is either outside (unchanged) or already updated. Equals a full
 * `computeClearance` (property test).
 */
export function updateClearance(g: NavGrid, dirty: CellRect): void {
  const x0 = Math.max(0, dirty.x0 - (CLEARANCE_MAX - 1));
  const y0 = Math.max(0, dirty.y0 - (CLEARANCE_MAX - 1));
  const x1 = Math.min(g.ccols, dirty.x1);
  const y1 = Math.min(g.crows, dirty.y1);
  for (let cy = y1 - 1; cy >= y0; cy--) for (let cx = x1 - 1; cx >= x0; cx--) g.clearance[cy * g.ccols + cx] = clearanceAt(g, cx, cy);
}
