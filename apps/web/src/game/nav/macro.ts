// apps/web/src/game/nav/macro.ts  (M15 T4, docs/design/navigation.md section 4.2)
//
// Tile-level A* per nav class: 8-connected, octile costs (1, SQRT2) in fixed point, no corner cutting
// (a diagonal step needs both orthogonal neighbours passable: easystar's `disableCornerCutting`, which
// the pre-M15 PathFinder used). For `small` a step also needs the two tiles to connect at the cell
// level across their shared edge (`smallEdgeOpen`): a half-tile divider leaves both tiles passable but
// cuts the hop, and the Navigator's per-tile repairs cannot route around a long divider. All buffers are
// allocated once per planner; a query allocates only its result. Ties break by h then tile id
// (invariant 7), so two runs give equal paths.
import type { Point } from '../procgen/types';
import { CLASS_K, type NavClass } from './classes';
import { FULL_MASK, SUB } from './constants';
import { bitOf, fits, isTileStandable } from './grid';
import { NodeHeap } from './heap';
import type { NavGrid } from './types';

export interface MacroOptions {
  /** Start may be impassable (a character mid-rebuild stands on a blocked tile). Default true. */
  allowBlockedStart?: boolean;
  /** Per-query extra blocks (tile indices), used by Navigator repairs. */
  blockedOverride?: ReadonlySet<number>;
}

/** Fixed-point step costs: x1000 so the octile heuristic stays an exact integer (consistent, never overestimates). */
export const MACRO_STRAIGHT = 1000;
export const MACRO_DIAGONAL = 1414;

/** Per-class tile passability (the only place it is defined). False outside the grid. */
export function tilePassable(g: NavGrid, cls: NavClass, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= g.cols || y >= g.rows) return false;
  switch (cls) {
    case 'person':
      return isTileStandable(g, x, y);
    case 'small':
      // At least one walkable cell: a cat squeezes past a half-tile footprint.
      return (g.masks[y * g.cols + x]! & FULL_MASK) !== 0;
    case 'large':
      return isTileStandable(g, x, y) && fits(g, x * SUB, y * SUB, CLASS_K.large);
  }
}

/** Octile distance in fixed point: `STRAIGHT * max + (DIAGONAL - STRAIGHT) * min`. */
const octile = (dx: number, dy: number): number => (dx > dy ? MACRO_STRAIGHT * dx + (MACRO_DIAGONAL - MACRO_STRAIGHT) * dy : MACRO_STRAIGHT * dy + (MACRO_DIAGONAL - MACRO_STRAIGHT) * dx);

// Neighbour order is fixed (part of determinism): E, W, S, N, then the four diagonals.
const DX = [1, -1, 0, 0, 1, -1, 1, -1];
const DY = [0, 0, 1, -1, 1, 1, -1, -1];

const PASS_UNKNOWN = 0;
const PASS_YES = 1;
const PASS_NO = 2;

export class MacroPlanner {
  private readonly n: number;
  /** Per class, per tile: 0 unknown, 1 passable, 2 blocked. Allocated on first use, dropped by `invalidate`. */
  private cache: Partial<Record<NavClass, Uint8Array>> = {};
  /** Fixed-point g cost; valid when `seen[i] === stamp`. */
  private readonly gCost: Int32Array;
  private readonly parent: Int32Array;
  private readonly seen: Int32Array;
  private readonly closed: Int32Array;
  private stamp = 0;
  private readonly heap: NodeHeap;

  constructor(readonly grid: NavGrid) {
    this.n = grid.cols * grid.rows;
    this.gCost = new Int32Array(this.n);
    this.parent = new Int32Array(this.n);
    this.seen = new Int32Array(this.n);
    this.closed = new Int32Array(this.n);
    this.heap = new NodeHeap(Math.max(64, this.n >> 2));
  }

  /** Drops the passability caches (grid changed). */
  invalidate(): void {
    this.cache = {};
  }

  /**
   * 8-connected tile path, both ends included, no corner cutting. null when `from`/`to` is outside the
   * grid, `to` is impassable (or overridden), the start is blocked and `allowBlockedStart` is false, or
   * `to` is unreachable. `from` equal to `to` gives `[from]`.
   */
  search(from: Point, to: Point, cls: NavClass, opts?: MacroOptions): Point[] | null {
    const g = this.grid;
    const cols = g.cols;
    if (!this.inside(from) || !this.inside(to)) return null;
    const override = opts?.blockedOverride;
    const pass = this.passCache(cls);
    const goal = to.y * cols + to.x;
    if (!this.passable(pass, cls, goal, to.x, to.y) || (override !== undefined && override.has(goal))) return null;
    if (from.x === to.x && from.y === to.y) return [from];
    const start = from.y * cols + from.x;
    if (opts?.allowBlockedStart === false && !this.passable(pass, cls, start, from.x, from.y)) return null;

    // The start tile counts as passable for this query (also as an orthogonal neighbour of a diagonal
    // step, as easystar did by temporarily marking it walkable). Nothing else re-enters it: it is closed first.
    const stamp = ++this.stamp;
    const { gCost, parent, seen, closed, heap } = this;
    heap.clear();
    gCost[start] = 0;
    parent[start] = -1;
    seen[start] = stamp;
    heap.push(start, octile(Math.abs(from.x - to.x), Math.abs(from.y - to.y)), 0);

    const rows = g.rows;
    let found = false;
    while (heap.size > 0) {
      const i = heap.pop();
      if (closed[i] === stamp) continue; // stale duplicate (lazy deletion)
      closed[i] = stamp;
      if (i === goal) {
        found = true;
        break;
      }
      const x = i % cols;
      const y = (i - x) / cols;
      const gi = gCost[i]!; // seen[i] === stamp: initialised this query
      for (let d = 0; d < 8; d++) {
        const nx = x + DX[d]!;
        const ny = y + DY[d]!;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (closed[ni] === stamp) continue;
        if (!this.stepPassable(pass, cls, ni, nx, ny, start, override)) continue;
        if (d >= 4) {
          // Diagonal: both orthogonal neighbours must be passable (no corner cutting).
          const ox = y * cols + nx; // (nx, y)
          const oy = ny * cols + x; // (x, ny)
          if (!this.stepPassable(pass, cls, ox, nx, y, start, override) || !this.stepPassable(pass, cls, oy, x, ny, start, override)) continue;
        }
        if (cls === 'small' && !this.smallEdgeOpen(i, ni, x, y, DX[d]!, DY[d]!, start)) continue;
        const ng = gi + (d >= 4 ? MACRO_DIAGONAL : MACRO_STRAIGHT);
        if (seen[ni] === stamp && ng >= gCost[ni]!) continue;
        seen[ni] = stamp;
        gCost[ni] = ng;
        parent[ni] = i;
        const h = octile(Math.abs(nx - to.x), Math.abs(ny - to.y));
        heap.push(ni, ng + h, h);
      }
    }
    if (!found) return null;

    // Walk the parent chain back to the start; `parent[]` is valid for every tile seen this query.
    let len = 0;
    for (let i = goal; i !== -1; i = parent[i]!) len++;
    const path: Point[] = new Array<Point>(len);
    let k = len - 1;
    for (let i = goal; i !== -1; i = parent[i]!) {
      const x = i % cols;
      path[k--] = { x, y: (i - x) / cols };
    }
    return path;
  }

  private inside(p: Point): boolean {
    return p.x >= 0 && p.y >= 0 && p.x < this.grid.cols && p.y < this.grid.rows;
  }

  private passCache(cls: NavClass): Uint8Array {
    let c = this.cache[cls];
    if (c === undefined) {
      c = new Uint8Array(this.n);
      this.cache[cls] = c;
    }
    return c;
  }

  /** Cached `tilePassable` for a tile inside the grid. */
  private passable(pass: Uint8Array, cls: NavClass, i: number, x: number, y: number): boolean {
    let v = pass[i]!; // i < n by construction
    if (v === PASS_UNKNOWN) {
      v = tilePassable(this.grid, cls, x, y) ? PASS_YES : PASS_NO;
      pass[i] = v;
    }
    return v === PASS_YES;
  }

  private stepPassable(pass: Uint8Array, cls: NavClass, i: number, x: number, y: number, start: number, override: ReadonlySet<number> | undefined): boolean {
    if (i === start) return true;
    if (override !== undefined && override.has(i)) return false;
    return this.passable(pass, cls, i, x, y);
  }

  /** Cell bits of a tile inside the grid for the small-edge rule; the start tile counts as fully free (it is passable for this query). */
  private cellsOf(i: number, start: number): number {
    return i === start ? FULL_MASK : this.grid.masks[i]! & FULL_MASK;
  }

  /**
   * A `small` (one-cell) body can step from tile `i` to its neighbour `ni` at (x + dx, y + dy) at the cell
   * level: a straight step needs a free cell pair across the shared edge; a diagonal step needs the two
   * corner cells that touch, plus the corner cells of both orthogonal tiles (no corner cutting at the
   * cell level). Uncached (a few bit tests on masks the step already reads).
   */
  private smallEdgeOpen(i: number, ni: number, x: number, y: number, dx: number, dy: number, start: number): boolean {
    const a = this.cellsOf(i, start);
    const b = this.cellsOf(ni, start);
    const last = SUB - 1;
    const has = (m: number, cx: number, cy: number): boolean => ((m >> bitOf(cx, cy)) & 1) === 1;
    if (dy === 0) {
      // E: a's last column against b's first; W: the mirror.
      const ca = dx > 0 ? last : 0;
      const cb = dx > 0 ? 0 : last;
      for (let r = 0; r < SUB; r++) if (has(a, ca, r) && has(b, cb, r)) return true;
      return false;
    }
    if (dx === 0) {
      const ra = dy > 0 ? last : 0;
      const rb = dy > 0 ? 0 : last;
      for (let c = 0; c < SUB; c++) if (has(a, c, ra) && has(b, c, rb)) return true;
      return false;
    }
    const cols = this.grid.cols;
    const e = this.cellsOf(y * cols + x + dx, start); // the orthogonal tile in x
    const s = this.cellsOf((y + dy) * cols + x, start); // the orthogonal tile in y
    const ax = dx > 0 ? last : 0;
    const ay = dy > 0 ? last : 0;
    return has(a, ax, ay) && has(b, last - ax, last - ay) && has(e, last - ax, ay) && has(s, ax, last - ay);
  }
}

/** A planner over `g` (the name the Navigator and the adapter use). */
export const createMacroSearch = (g: NavGrid): MacroPlanner => new MacroPlanner(g);
