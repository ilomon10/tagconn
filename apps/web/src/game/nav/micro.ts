// apps/web/src/game/nav/micro.ts  (M15 T6, docs/design/navigation.md section 4.3)
//
// Cell-level navigation between the macro tiles: line of sight over anchor cells (a k x k block
// slides along a segment iff every anchor cell the segment's supercover touches has clearance k),
// a windowed A* that repairs one hop when the straight line is blocked, and greedy string pulling.
// Pure TS, no Phaser; same fixed-point costs and tie-breaks as the macro planner (determinism).
import type { Point } from '../procgen/types';
import { SUB } from './constants';
import { anchorOfPoint, fits, pointOfAnchor } from './grid';
import { NodeHeap } from './heap';
import { MACRO_DIAGONAL, MACRO_STRAIGHT } from './macro';
import type { CellRect, NavGrid } from './types';

/** Expansion budget of one windowed micro search (the largest hop window, k = 3 diagonal, is 8 x 8 = 64 cells). */
export const MICRO_MAX_NODES = 64;

/**
 * Supercover line (Dedu's Bresenham variant): visits every cell whose closed square the closed segment
 * between the centres of cells `(x0, y0)` and `(x1, y1)` touches. A step through a cell corner visits
 * both side cells (conservative: a block must not slip between two diagonal cells). Stops at the first
 * `visit` returning false and returns false; true when every cell passed.
 */
export function supercover(x0: number, y0: number, x1: number, y1: number, visit: (x: number, y: number) => boolean): boolean {
  if (!visit(x0, y0)) return false;
  let dx = x1 - x0;
  let dy = y1 - y0;
  const xstep = dx < 0 ? -1 : 1;
  const ystep = dy < 0 ? -1 : 1;
  if (dx < 0) dx = -dx;
  if (dy < 0) dy = -dy;
  const ddx = 2 * dx;
  const ddy = 2 * dy;
  let x = x0;
  let y = y0;
  if (ddx >= ddy) {
    let error = dx;
    let errorprev = dx;
    for (let i = 0; i < dx; i++) {
      x += xstep;
      error += ddy;
      if (error > ddx) {
        y += ystep;
        error -= ddx;
        // Which side of the corner the segment crossed; exactly through it: both.
        if (error + errorprev < ddx) {
          if (!visit(x, y - ystep)) return false;
        } else if (error + errorprev > ddx) {
          if (!visit(x - xstep, y)) return false;
        } else if (!visit(x, y - ystep) || !visit(x - xstep, y)) return false;
      }
      if (!visit(x, y)) return false;
      errorprev = error;
    }
  } else {
    let error = dy;
    let errorprev = dy;
    for (let i = 0; i < dy; i++) {
      y += ystep;
      error += ddx;
      if (error > ddy) {
        x += xstep;
        error -= ddy;
        if (error + errorprev < ddy) {
          if (!visit(x - xstep, y)) return false;
        } else if (error + errorprev > ddy) {
          if (!visit(x, y - ystep)) return false;
        } else if (!visit(x - xstep, y) || !visit(x, y - ystep)) return false;
      }
      if (!visit(x, y)) return false;
      errorprev = error;
    }
  }
  return true;
}

/** Supercover line from `anchorOfPoint(a, k)` to `anchorOfPoint(b, k)`: every anchor cell the segment touches must `fits(k)`. */
export function lineOfSight(g: NavGrid, a: Point, b: Point, k: number): boolean {
  const s = anchorOfPoint(a, k);
  const t = anchorOfPoint(b, k);
  return supercover(s.x, s.y, t.x, t.y, (x, y) => fits(g, x, y, k));
}

/** The micro window for repairing the hop between two tiles: their cell rect grown by k - 1 on every side. */
export function hopWindow(a: Point, b: Point, k: number): CellRect {
  const grow = k - 1;
  return {
    x0: Math.min(a.x, b.x) * SUB - grow,
    y0: Math.min(a.y, b.y) * SUB - grow,
    x1: (Math.max(a.x, b.x) + 1) * SUB + grow,
    y1: (Math.max(a.y, b.y) + 1) * SUB + grow,
  };
}

// Neighbour order as the macro planner: E, W, S, N, then the four diagonals (determinism).
const DX = [1, -1, 0, 0, 1, -1, 1, -1];
const DY = [0, 0, 1, -1, 1, 1, -1, -1];

const octile = (dx: number, dy: number): number => (dx > dy ? MACRO_STRAIGHT * dx + (MACRO_DIAGONAL - MACRO_STRAIGHT) * dy : MACRO_STRAIGHT * dy + (MACRO_DIAGONAL - MACRO_STRAIGHT) * dx);

/**
 * 8-connected A* over anchor cells inside `window` (clipped to the grid), at most `maxNodes` expansions.
 * A cell is passable when a k x k block anchored there fits; the start cell always is (a body may stand
 * where it no longer fits); a diagonal step needs both orthogonal cells passable (no corner cutting), so
 * consecutive result points are line-of-sight adjacent by construction. Returns nav points: `from`, the
 * centres of the intermediate anchors, `to`; null when an end is outside the window, `to` does not fit,
 * or the budget runs out. Allocates only window-sized buffers (a few dozen cells).
 */
export function microAStar(g: NavGrid, from: Point, to: Point, k: number, window: CellRect, maxNodes = MICRO_MAX_NODES): Point[] | null {
  const x0 = Math.max(0, window.x0);
  const y0 = Math.max(0, window.y0);
  const x1 = Math.min(g.ccols, window.x1);
  const y1 = Math.min(g.crows, window.y1);
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const s = anchorOfPoint(from, k);
  const t = anchorOfPoint(to, k);
  const inside = (x: number, y: number): boolean => x >= x0 && y >= y0 && x < x1 && y < y1;
  if (!inside(s.x, s.y) || !inside(t.x, t.y)) return null;
  if (!fits(g, t.x, t.y, k)) return null;
  const start = (s.y - y0) * w + (s.x - x0);
  const goal = (t.y - y0) * w + (t.x - x0);
  if (start === goal) return [from, to];

  const n = w * h;
  const gCost = new Int32Array(n);
  const parent = new Int32Array(n).fill(-1);
  const state = new Uint8Array(n); // 0 unseen, 1 open, 2 closed
  const heap = new NodeHeap(n);
  const passable = (i: number, x: number, y: number): boolean => i === start || fits(g, x, y, k);

  gCost[start] = 0;
  state[start] = 1;
  heap.push(start, octile(Math.abs(s.x - t.x), Math.abs(s.y - t.y)), 0);
  let expansions = 0;
  let found = false;
  while (heap.size > 0) {
    const i = heap.pop();
    if (state[i] === 2) continue; // stale duplicate (lazy deletion)
    state[i] = 2;
    if (i === goal) {
      found = true;
      break;
    }
    if (expansions === maxNodes) return null;
    expansions++;
    const lx = i % w;
    const ly = (i - lx) / w;
    const x = x0 + lx;
    const y = y0 + ly;
    const gi = gCost[i]!; // state[i] !== 0: initialised
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d]!;
      const ny = y + DY[d]!;
      if (!inside(nx, ny)) continue;
      const ni = (ny - y0) * w + (nx - x0);
      if (state[ni] === 2) continue;
      if (!passable(ni, nx, ny)) continue;
      if (d >= 4) {
        // Diagonal: both orthogonal neighbours must be passable (no corner cutting).
        const ox = (y - y0) * w + (nx - x0); // (nx, y)
        const oy = (ny - y0) * w + (x - x0); // (x, ny)
        if (!passable(ox, nx, y) || !passable(oy, x, ny)) continue;
      }
      const ng = gi + (d >= 4 ? MACRO_DIAGONAL : MACRO_STRAIGHT);
      if (state[ni] === 1 && ng >= gCost[ni]!) continue;
      state[ni] = 1;
      gCost[ni] = ng;
      parent[ni] = i;
      const hh = octile(Math.abs(nx - t.x), Math.abs(ny - t.y));
      heap.push(ni, ng + hh, hh);
    }
  }
  if (!found) return null;

  // Parent chain back to the start; the ends are the exact input points, the middle anchor centres.
  const cells: number[] = [];
  for (let i = parent[goal]!; i !== start; i = parent[i]!) cells.push(i);
  const out: Point[] = [from];
  for (let j = cells.length - 1; j >= 0; j--) {
    const i = cells[j]!;
    const lx = i % w;
    out.push(pointOfAnchor({ x: x0 + lx, y: y0 + (i - lx) / w }, k));
  }
  out.push(to);
  return out;
}

/** The furthest index `j > i` such that every `pts[i] -> pts[j']` for `i < j' <= j` has line of sight; at least `i + 1`. */
export function pullNext(g: NavGrid, pts: readonly Point[], i: number, k: number): number {
  let j = i + 1;
  while (j + 1 < pts.length && lineOfSight(g, pts[i]!, pts[j + 1]!, k)) j++;
  return j;
}

/** Greedy string pulling: from i, keep the furthest j with line of sight; emit pts[j]; repeat. Both ends kept. */
export function pullString(g: NavGrid, pts: readonly Point[], k: number): Point[] {
  if (pts.length === 0) return [];
  const out: Point[] = [pts[0]!];
  for (let i = 0; i + 1 < pts.length; ) {
    const j = pullNext(g, pts, i, k);
    out.push(pts[j]!);
    i = j;
  }
  return out;
}
