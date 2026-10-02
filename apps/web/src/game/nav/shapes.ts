// apps/web/src/game/nav/shapes.ts  (M15 T1, docs/design/navigation.md section 2.3)
//
// Which cells of a furniture footprint block walking. Keyed by `FurnitureKind` only (D2: a skin switch
// never changes a mask). M15 start: every kind is `'full'` or `'none'` per `KIND_BLOCKING`, so routing
// is unchanged until W4 tunes shapes (desk insets, plant pots, round tables).
import { KIND_BLOCKING } from '../procgen/pins';
import type { FurnitureKind } from '../procgen/types';
import type { CellRect } from './types';

/** Which cells of a footprint block. Insets are in cells from the footprint edge. */
export type NavShape =
  | 'full'
  | 'none'
  | { inset: { n: number; e: number; s: number; w: number } }
  /** `[cy][cx]` over the footprint's cells (w x h cells); a missing entry means walkable. */
  | { mask: (w: number, h: number) => boolean[][] };

/** Style-independent (D2). Exhaustive over `FurnitureKind` (the `Record` type enforces it). */
export const KIND_SHAPE: Record<FurnitureKind, NavShape> = Object.fromEntries(
  (Object.keys(KIND_BLOCKING) as FurnitureKind[]).map((kind) => [kind, KIND_BLOCKING[kind] ? 'full' : 'none']),
) as Record<FurnitureKind, NavShape>;

/** Predicate over cells inside `cells` (absolute cell coords) for `shape`; false for cells outside the rect. */
export function blockedCells(shape: NavShape, cells: CellRect): (cx: number, cy: number) => boolean {
  const inside = (cx: number, cy: number) => cx >= cells.x0 && cx < cells.x1 && cy >= cells.y0 && cy < cells.y1;
  if (shape === 'full') return inside;
  if (shape === 'none') return () => false;
  if ('inset' in shape) {
    const { n, e, s, w } = shape.inset;
    return (cx, cy) => cx >= cells.x0 + w && cx < cells.x1 - e && cy >= cells.y0 + n && cy < cells.y1 - s;
  }
  const mask = shape.mask(cells.x1 - cells.x0, cells.y1 - cells.y0);
  return (cx, cy) => inside(cx, cy) && mask[cy - cells.y0]?.[cx - cells.x0] === true;
}
