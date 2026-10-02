// apps/web/src/game/nav/shapes.ts  (M15 T1, docs/design/navigation.md section 2.3)
//
// Which cells of a furniture footprint block walking. Keyed by `FurnitureKind` only (D2: a skin switch
// never changes a mask). M16 F2 tunes shapes (desk insets, plant pots, round tables); the rest stay `'full'` or
// `'none'` per `KIND_BLOCKING`.
import type { Facing } from '@tagconn/shared';
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

type Inset = { n: number; e: number; s: number; w: number };
const insetShape = (n: number, e: number, s: number, w: number): NavShape => ({ inset: { n, e, s, w } });

/** Round footprint: the four corner cells stay walkable (only `small` fits through; a tile with one free cell is still non-standable). */
const roundMask = (w: number, h: number): boolean[][] =>
  Array.from({ length: h }, (_, cy) => Array.from({ length: w }, (_, cx) => !((cx === 0 || cx === w - 1) && (cy === 0 || cy === h - 1))));

/**
 * Style-independent (D2). Exhaustive over `FurnitureKind` (the `Record` type enforces it). Insets are for the
 * canonical `s` facing (chair on the south side); `insetFor` rotates them (furnishing.md section 4.1). Everything not
 * listed is `'full'` or `'none'` per `KIND_BLOCKING`.
 */
export const KIND_SHAPE: Record<FurnitureKind, NavShape> = {
  ...(Object.fromEntries((Object.keys(KIND_BLOCKING) as FurnitureKind[]).map((kind) => [kind, KIND_BLOCKING[kind] ? 'full' : 'none'])) as Record<FurnitureKind, NavShape>),
  // A chair tucks under the chair-side edge: that half tile stays open for small creatures.
  'work-desk': insetShape(0, 0, 1, 0),
  'lead-desk': insetShape(0, 0, 1, 0),
  'reading-table': insetShape(0, 0, 1, 0),
  booth: insetShape(0, 0, 1, 0),
  // People stand at both long sides.
  'standing-table': insetShape(1, 0, 1, 0),
  // Pot-sized centre (only the middle blocks; a one-tile footprint has no centre to keep).
  plant: insetShape(1, 1, 1, 1),
  lamp: insetShape(1, 1, 1, 1),
  centerpiece: { mask: roundMask },
};

const isInset = (shape: NavShape): shape is { inset: Inset } => typeof shape === 'object' && 'inset' in shape;

/** Rotates a canonical (`s`) inset to `facing`: `n` flips n/s, `e` turns s to e (n to w), `w` turns s to w (n to e). Other shapes are unchanged. */
export function rotateShape(shape: NavShape, facing: Facing = 's'): NavShape {
  if (!isInset(shape) || facing === 's') return shape;
  const { n, e, s, w } = shape.inset;
  if (facing === 'n') return insetShape(s, e, n, w);
  if (facing === 'e') return insetShape(e, s, w, n);
  return insetShape(w, n, e, s);
}

/** The nav shape of `kind` placed with `facing`. Own-property guarded: a kind that is not in the table (`constructor`, `__proto__`) gets no inset, a full block. */
export function insetFor(kind: string, facing: Facing = 's'): NavShape {
  return Object.hasOwn(KIND_SHAPE, kind) ? rotateShape(KIND_SHAPE[kind as FurnitureKind], facing) : 'full';
}

/** Predicate over cells inside `cells` (absolute cell coords) for `shape`; false for cells outside the rect. */
export function blockedCells(shape: NavShape, cells: CellRect): (cx: number, cy: number) => boolean {
  const inside = (cx: number, cy: number) => cx >= cells.x0 && cx < cells.x1 && cy >= cells.y0 && cy < cells.y1;
  if (shape === 'full') return inside;
  if (shape === 'none') return () => false;
  if ('inset' in shape) {
    // Insets are >= 0 cells (shaving the footprint inwards); a negative inset would reach outside the rect.
    const { n, e, s, w } = shape.inset;
    return (cx, cy) => cx >= cells.x0 + w && cx < cells.x1 - e && cy >= cells.y0 + n && cy < cells.y1 - s;
  }
  const mask = shape.mask(cells.x1 - cells.x0, cells.y1 - cells.y0);
  return (cx, cy) => inside(cx, cy) && mask[cy - cells.y0]?.[cx - cells.x0] === true;
}
