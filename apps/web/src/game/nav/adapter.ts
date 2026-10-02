// apps/web/src/game/nav/adapter.ts  (M15 T4, docs/design/navigation.md section 4.5)
//
// `PathFinder` with the pre-M15 easystar wrapper's semantics on top of the macro planner, so the 12
// `find` callers (life, drama, NPC scripts, seats) keep working unchanged while the Navigator (T6)
// lands behind the same object. `game/pathfinding.ts` re-exports this.
import type { Point } from '../procgen/types';
import { isTileStandable, navGridFromWalkable, tileOfNavPoint } from './grid';
import { MacroPlanner } from './macro';
import type { NavGrid } from './types';

export class PathFinder {
  readonly nav: NavGrid;
  private readonly macro: MacroPlanner;

  /** A NavGrid, or a legacy `number[][]` walkable grid (wrapped with `navGridFromWalkable`). */
  constructor(source: NavGrid | readonly (readonly number[])[]) {
    this.nav = Array.isArray(source) ? navGridFromWalkable(source) : (source as NavGrid);
    this.macro = new MacroPlanner(this.nav);
  }

  /** A person can stand on the tile (`walkable[y][x] === 0` for a map-built grid). False outside. */
  isWalkable(p: Point): boolean {
    return isTileStandable(this.nav, p.x, p.y);
  }

  /**
   * Tile path from `from` to `to` (both included), or null. Exactly the old wrapper: null when either
   * end is outside the grid or `to` is not standable; `[from]` when the ends are equal; a blocked
   * `from` is allowed (a character mid-rebuild may stand on furniture) and every later tile is
   * standable; consecutive tiles are 8-adjacent, never a corner cut, never a duplicate.
   */
  find(from: Point, to: Point): Point[] | null {
    if (!this.isWalkable(to)) return null;
    return this.macro.search(from, to, 'person', { allowBlockedStart: true });
  }
}

/** Tiles under a sequence of nav points, consecutive duplicates removed (legacy consumers of px paths). */
export function collapseToTiles(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const t = tileOfNavPoint(p);
    const last = out[out.length - 1];
    if (last !== undefined && last.x === t.x && last.y === t.y) continue;
    out.push(t);
  }
  return out;
}
