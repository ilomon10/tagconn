// apps/web/src/game/nav/navigator.ts  (M15 T6, docs/design/navigation.md section 4.4)
//
// Px navigation per nav class: a macro tile path (macro.ts), threaded into anchors (the real ends,
// per-class anchor points of the tiles in between), checked hop by hop with line of sight and repaired
// with a windowed micro search where the straight line is blocked; a hop no micro search can mend
// marks the tile and re-runs the macro (at most MAX_REPAIRS times, then the tile anchors are walked as
// is, today's behaviour). The NavPath string-pulls lazily: `nextSegment` does the LOS work for one
// straight segment at a time, so an interrupted walk never pays for the rest of the path.
import type { Point } from '../procgen/types';
import { CLASS_K, type NavClass } from './classes';
import { SUB } from './constants';
import { anchorOfPoint, fits, navPointOfTile, pointOfAnchor, tileIndex, tileOfNavPoint } from './grid';
import { createMacroSearch, type MacroPlanner } from './macro';
import { hopWindow, lineOfSight, microAStar, pullNext } from './micro';
import type { CellRect, NavGrid } from './types';

/** Macro re-runs a `findPath` may spend before it gives up on repairs and walks the tile anchors as is. */
export const MAX_REPAIRS = 3;

export interface NavPath {
  readonly cls: NavClass;
  /** Nav px. */
  readonly from: Point;
  readonly to: Point;
  /** Macro tiles (both ends, 8-adjacent, no corner cuts). */
  readonly tiles: readonly Point[];
  /** Macro re-runs this path needed (0 for every `person` path on a map-built grid). */
  readonly repairs: number;
  /** False when the repairs ran out: the tile anchors are walked as they are (today's tile path), no string pulling. */
  readonly pulled: boolean;
  /** Next straight-segment end in nav px, or null when the path is consumed. Incremental: LOS work happens here. */
  nextSegment(): Point | null;
  /** True once `nextSegment` returned the last point (or there was none to return). */
  readonly done: boolean;
  /** Every segment end from the start, without consuming the path (what `nextSegment` would return in sequence). */
  toPoints(): Point[];
}

class LazyNavPath implements NavPath {
  private cursor = 0;

  constructor(
    readonly cls: NavClass,
    readonly from: Point,
    readonly to: Point,
    readonly tiles: readonly Point[],
    readonly repairs: number,
    readonly pulled: boolean,
    /** `from`, the threaded anchors, `to` (just `[from]` when nothing moves). */
    private readonly anchors: readonly Point[],
    private readonly g: NavGrid,
    private readonly k: number,
  ) {}

  get done(): boolean {
    return this.cursor >= this.anchors.length - 1;
  }

  nextSegment(): Point | null {
    if (this.done) return null;
    const j = this.pulled ? pullNext(this.g, this.anchors, this.cursor, this.k) : this.cursor + 1;
    this.cursor = j;
    return this.anchors[j]!;
  }

  toPoints(): Point[] {
    const out: Point[] = [];
    for (let i = 0; i + 1 < this.anchors.length; ) {
      const j = this.pulled ? pullNext(this.g, this.anchors, i, this.k) : i + 1;
      out.push(this.anchors[j]!);
      i = j;
    }
    return out;
  }
}

/**
 * The nav point a class walks through on a tile. `person` (k = SUB) is the tile centre (today's feet
 * point). A smaller class takes the first cell of the tile (row-major) its block fits in: a half-blocked
 * tile has no centred block, and the tile is on the macro path because some cell of it is free. A larger
 * class anchors on the tile's top-left cell (the macro checked that block).
 */
export function tileAnchorPoint(g: NavGrid, t: Point, k: number): Point {
  if (k >= SUB) return navPointOfTile(t, k);
  const cx0 = t.x * SUB;
  const cy0 = t.y * SUB;
  for (let cy = cy0; cy < cy0 + SUB; cy++) for (let cx = cx0; cx < cx0 + SUB; cx++) if (fits(g, cx, cy, k)) return pointOfAnchor({ x: cx, y: cy }, k);
  return navPointOfTile(t, k);
}

export class Navigator {
  private readonly macro: MacroPlanner;

  /** `macro` lets the adapter share its planner (and passability caches) with the navigator. */
  constructor(readonly grid: NavGrid, macro?: MacroPlanner) {
    this.macro = macro ?? createMacroSearch(grid);
  }

  /**
   * Null when `to` is outside the grid or a k x k block centred on it does not fit (today's null for a
   * blocked target), or the macro finds no tile route. The start may be blocked (a character mid-rebuild
   * stands on furniture): its first hop is walked straight, as today.
   */
  findPath(from: Point, to: Point, cls: NavClass): NavPath | null {
    const g = this.grid;
    const k = CLASS_K[cls];
    const goal = anchorOfPoint(to, k);
    if (!fits(g, goal.x, goal.y, k)) return null;
    const tFrom = tileOfNavPoint(from);
    const tTo = tileOfNavPoint(to);
    const startAnchor = anchorOfPoint(from, k);
    const startBlocked = !fits(g, startAnchor.x, startAnchor.y, k);
    const samePoint = from.x === to.x && from.y === to.y;

    let override: Set<number> | undefined;
    let tiles: Point[] | null = null;
    let repairs = 0;
    for (;;) {
      tiles = this.macro.search(tFrom, tTo, cls, { allowBlockedStart: true, blockedOverride: override });
      if (!tiles) return null;
      if (samePoint) return new LazyNavPath(cls, from, to, tiles, repairs, true, [from], g, k);
      // Thread the hops: the real ends, per-class anchors of the tiles in between. A single-tile path
      // is one hop inside that tile.
      const hops = Math.max(1, tiles.length - 1);
      const anchors: Point[] = [from];
      let failed = -1;
      for (let h = 0; h < hops; h++) {
        const a = anchors[anchors.length - 1]!;
        const last = h === hops - 1;
        const b = last ? to : tileAnchorPoint(g, tiles[h + 1]!, k);
        if ((h === 0 && startBlocked) || lineOfSight(g, a, b, k)) {
          anchors.push(b);
          continue;
        }
        const micro = microAStar(g, a, b, k, hopWindow(tiles[h]!, tiles[Math.min(h + 1, tiles.length - 1)]!, k));
        if (micro) {
          for (let i = 1; i < micro.length; i++) anchors.push(micro[i]!);
          continue;
        }
        failed = h;
        break;
      }
      if (failed < 0) return new LazyNavPath(cls, from, to, tiles, repairs, true, anchors, g, k);
      // Mark the tile the hop could not enter (its predecessor when the hop enters the goal) and re-run the
      // macro; a hop that leaves the start for the goal has nothing left to mark.
      const mark = failed + 1 < tiles.length - 1 ? tiles[failed + 1]! : failed > 0 ? tiles[failed]! : null;
      if (mark === null || repairs === MAX_REPAIRS) break;
      override ??= new Set<number>();
      override.add(tileIndex(g, mark.x, mark.y));
      repairs++;
    }
    // Gave up: the last macro route with its tile anchors, walked as they are (today's tile path).
    const anchors: Point[] = [from];
    for (let i = 1; i + 1 < tiles.length; i++) anchors.push(tileAnchorPoint(g, tiles[i]!, k));
    anchors.push(to);
    return new LazyNavPath(cls, from, to, tiles, repairs, false, anchors, g, k);
  }

  /** Grid changed (live furniture edit, map rebuild): drops caches. `dirty` is advisory in M15 (full invalidate). */
  invalidate(_dirty?: CellRect): void {
    this.macro.invalidate();
  }
}

/** A navigator over `g` (the name the adapter uses). */
export const createNavigator = (g: NavGrid, macro?: MacroPlanner): Navigator => new Navigator(g, macro);
