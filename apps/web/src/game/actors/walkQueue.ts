// apps/web/src/game/actors/walkQueue.ts  (M15 T6, docs/design/navigation.md section 4.6)
//
// The pure part of a Character's walk: the queue of feet px targets it steps through, fed either by a
// fixed point list (`walk` / `walkPoints`) or lazily by a NavPath (`walkNav`, one straight segment at a
// time, so the line-of-sight work of a long path is spread over the walk and never paid for a walk that
// gets replaced). No Phaser: tested directly in actors/__tests__/characterNav.test.ts.
import { FEET_DY, TILE_PX } from '../nav/constants';
import type { NavPath } from '../nav/navigator';
import type { Point } from '../procgen/types';

/** M17 hook: the direction a character walks in; today only the sprite's horizontal flip reads it. */
export type Facing = 'n' | 'e' | 's' | 'w';

/** Feet px of a nav point (the nav point is the feet shifted up by FEET_DY). */
export const feetOfNavPoint = (p: Point): Point => ({ x: p.x, y: p.y + FEET_DY });

/** Today's feet px of a tile: `(tx * 16 + 8, ty * 16 + 14)` (`Character.teleport`). Equals `feetOfNavPoint(navPointOfTile(t))`. */
export const feetOfTile = (t: Point): Point => ({ x: t.x * TILE_PX + TILE_PX / 2, y: t.y * TILE_PX + TILE_PX / 2 + FEET_DY });

/**
 * Facing from a step vector (screen y grows downwards): the dominant axis, horizontal on a tie (the
 * sprite flip is horizontal too). A zero vector keeps `current`.
 */
export function facingOf(dx: number, dy: number, current: Facing): Facing {
  if (dx === 0 && dy === 0) return current;
  if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'w' : 'e';
  return dy < 0 ? 'n' : 's';
}

export class WalkQueue {
  /** Feet px targets still to reach, in order. */
  private points: Point[] = [];
  /** The NavPath the queue refills from when `points` runs empty (null for a fixed list). */
  private path: NavPath | null = null;

  /** Replaces everything with a fixed list of feet px targets. */
  setFeet(points: readonly Point[]): void {
    this.points = [...points];
    this.path = null;
  }

  /** Replaces everything with a NavPath; segments are pulled as the walk reaches them. */
  setNav(path: NavPath): void {
    this.points = [];
    this.path = path;
  }

  clear(): void {
    this.points = [];
    this.path = null;
  }

  /** A target is queued or an unfinished NavPath can still give one. */
  get walking(): boolean {
    return this.points.length > 0 || (this.path !== null && !this.path.done);
  }

  /** The current feet target, pulling the next NavPath segment when the queue is empty; null when nothing is left. */
  peek(): Point | null {
    if (this.points.length === 0 && this.path !== null) {
      const next = this.path.nextSegment();
      if (next !== null) this.points.push(feetOfNavPoint(next));
      if (this.path.done) this.path = null;
    }
    return this.points[0] ?? null;
  }

  /** Drops the current target (reached). */
  shift(): void {
    this.points.shift();
  }
}
