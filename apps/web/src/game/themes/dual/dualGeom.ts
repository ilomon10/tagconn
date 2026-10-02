// apps/web/src/game/themes/dual/dualGeom.ts  (M15 dual grid, docs/design/dual-grid.md section 1.4)
//
// The 16-case dual-grid lookup and the pixel geometry of a cell's centre cross: which half-edges of
// the cross separate a set quadrant from an unset one, the strip along such a half-edge, and the
// corner pixels of a convex corner. Pure TS, no Phaser; every painter builds its rects from here.
import type { Rect } from '../../procgen/types';
import { BIT, type DualCell, type Quadrant } from './dualGrid';

export type Side = 'n' | 'e' | 's' | 'w';
/** The two quadrants a centre-cross half-edge separates (first = the one on the n/w side). */
export const HALF_EDGE_QUADRANTS: Record<Side, readonly [Quadrant, Quadrant]> = {
  n: ['tl', 'tr'],
  e: ['tr', 'br'],
  s: ['bl', 'br'],
  w: ['tl', 'bl'],
};
export const SIDES: readonly Side[] = ['n', 'e', 's', 'w'];

export type Shape =
  | { kind: 'none' } // 0 or 15
  | { kind: 'edge'; side: Side } // two adjacent quadrants set; `side` = where the SET half lies
  | { kind: 'convex'; q: Quadrant } // one quadrant set: an outer corner of the set region at the centre
  | { kind: 'concave'; notch: Quadrant } // three set: an inner corner; `notch` is the unset quadrant
  | { kind: 'diagonal'; pair: 'tl-br' | 'tr-bl' }; // two opposite quadrants set

const QUADRANT_OF_BIT: Record<number, Quadrant> = { 8: 'tl', 4: 'tr', 2: 'bl', 1: 'br' };

/** The 16-case lookup (mask bits tl=8 tr=4 bl=2 br=1). */
export function shapeOf(mask: number): Shape {
  switch (mask & 0xf) {
    case 0:
    case 15:
      return { kind: 'none' };
    case 12:
      return { kind: 'edge', side: 'n' };
    case 3:
      return { kind: 'edge', side: 's' };
    case 10:
      return { kind: 'edge', side: 'w' };
    case 5:
      return { kind: 'edge', side: 'e' };
    case 9:
      return { kind: 'diagonal', pair: 'tl-br' };
    case 6:
      return { kind: 'diagonal', pair: 'tr-bl' };
    case 8:
    case 4:
    case 2:
    case 1:
      return { kind: 'convex', q: QUADRANT_OF_BIT[mask & 0xf]! };
    default:
      // 7, 11, 13, 14: exactly one bit unset.
      return { kind: 'concave', notch: QUADRANT_OF_BIT[~mask & 0xf]! };
  }
}

/** Half-edges of the centre cross that separate a set quadrant from an unset one (HALF_EDGE_QUADRANTS). */
export function boundaryHalfEdges(mask: number): Side[] {
  const out: Side[] = [];
  for (const side of SIDES) {
    const [a, b] = HALF_EDGE_QUADRANTS[side];
    const setA = (mask & BIT[a]) !== 0;
    const setB = (mask & BIT[b]) !== 0;
    if (setA !== setB) out.push(side);
  }
  return out;
}

/**
 * A strip `t` px thick along half-edge `side`, lying inside quadrant `towards` (one of
 * `HALF_EDGE_QUADRANTS[side]`). With centre `c = (px + T/2, py + T/2)`: `n` runs from `c` up to `(c.x, py)`,
 * `e` right, `s` down, `w` left; the strip hugs the half-edge on the `towards` side.
 */
export function halfEdgeStrip(px: number, py: number, T: number, side: Side, towards: Quadrant, t: number): Rect {
  const half = T / 2;
  const cx = px + half;
  const cy = py + half;
  const [first, second] = HALF_EDGE_QUADRANTS[side];
  if (towards !== first && towards !== second) {
    throw new Error(`halfEdgeStrip: quadrant ${towards} is not on half-edge ${side}`);
  }
  // `first` is the n/w side of the half-edge: for the vertical half-edges (n, s) it lies left of the
  // line, for the horizontal ones (e, w) above it.
  const before = towards === first;
  switch (side) {
    case 'n':
      return { x: before ? cx - t : cx, y: py, w: t, h: half };
    case 's':
      return { x: before ? cx - t : cx, y: cy, w: t, h: half };
    case 'e':
      return { x: cx, y: before ? cy - t : cy, w: half, h: t };
    case 'w':
      return { x: px, y: before ? cy - t : cy, w: half, h: t };
  }
}

/**
 * Corner pixels to recolour for a convex corner in quadrant `q`, measured from the cell centre into `q`:
 * r=1 → [(0,0)]; r=2 → [(0,0),(1,0),(0,1)], as absolute 1x1 px rects (painters may merge (0,0)+(1,0) to 2x1).
 */
export function cornerCut(cell: Pick<DualCell, 'cx' | 'cy'>, q: Quadrant, r: 1 | 2, T: number): Rect[] {
  // The cell centre is the tile corner itself.
  const cx = cell.cx * T;
  const cy = cell.cy * T;
  const left = q === 'tl' || q === 'bl';
  const up = q === 'tl' || q === 'tr';
  const at = (i: number, j: number): Rect => ({ x: left ? cx - 1 - i : cx + i, y: up ? cy - 1 - j : cy + j, w: 1, h: 1 });
  return r === 1 ? [at(0, 0)] : [at(0, 0), at(1, 0), at(0, 1)];
}
