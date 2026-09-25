import * as EasyStarNS from 'easystarjs';
import type { Point } from './map/officeMap';

// easystarjs is CommonJS; depending on the bundler the namespace may sit under `default`.
const EasyStar: typeof EasyStarNS = (EasyStarNS as unknown as { default?: typeof EasyStarNS }).default ?? EasyStarNS;

/** Thin synchronous wrapper around easystarjs for the small office grid. */
export class PathFinder {
  private es = new EasyStar.js();
  private cols: number;
  private rows: number;

  constructor(private walkable: number[][]) {
    this.rows = walkable.length;
    this.cols = walkable[0]?.length ?? 0;
    this.es.setGrid(walkable);
    this.es.setAcceptableTiles([0]);
    this.es.enableDiagonals();
    this.es.disableCornerCutting();
    this.es.enableSync();
  }

  isWalkable(p: Point): boolean {
    return this.walkable[p.y]?.[p.x] === 0;
  }

  /** Path from `from` to `to` (both included), or null if unreachable. */
  find(from: Point, to: Point): Point[] | null {
    const inside = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < this.cols && p.y < this.rows;
    if (!inside(from) || !inside(to) || !this.isWalkable(to)) return null;
    if (from.x === to.x && from.y === to.y) return [from];
    // A character may momentarily stand on a blocked tile (e.g. after a map rebuild): start from it anyway.
    const startBlocked = !this.isWalkable(from);
    if (startBlocked) this.walkable[from.y]![from.x] = 0;
    let result: Point[] | null = null;
    this.es.setGrid(this.walkable);
    this.es.findPath(from.x, from.y, to.x, to.y, (path) => {
      result = path ? path.map((p) => ({ x: p.x, y: p.y })) : null;
    });
    this.es.calculate();
    if (startBlocked) {
      this.walkable[from.y]![from.x] = 1;
      this.es.setGrid(this.walkable);
    }
    return result;
  }
}
