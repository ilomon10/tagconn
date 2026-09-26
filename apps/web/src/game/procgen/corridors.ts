import { footprintRing, SIDE_DIR, type DoorRoomShape, type Side } from './doors';
import type { Point, TileKind } from './types';

/** A void tile just outside a room's footprint, a candidate endpoint for a carved corridor. */
export interface ExitCandidate {
  roomId: string;
  /** The room-side footprint tile (a wall tile for a walled room, a floor edge tile for an open one). */
  roomTile: Point;
  /** The wall tile to open into a door, or null for an open room (no wall to open). */
  doorTile: Point | null;
  voidTile: Point;
  side: Side;
  /** M8 8n: true for a synthetic exit built from an explicit `room.doors` entry (not a wall opening
   *  the generator chose on its own), so the resulting `Door.auto` can be reported as `false`. */
  explicit?: boolean;
}

/** Every place a corridor could leave a room: a footprint edge tile whose outward neighbour is void. */
export function findExitCandidates(rooms: readonly DoorRoomShape[], tiles: readonly TileKind[][]): ExitCandidate[] {
  const rows = tiles.length;
  const cols = tiles[0]?.length ?? 0;
  const inBounds = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows;
  const out: ExitCandidate[] = [];
  for (const room of rooms) {
    for (const { p, side } of footprintRing(room.footprint)) {
      const dir = SIDE_DIR[side];
      const outp = { x: p.x + dir.x, y: p.y + dir.y };
      if (!inBounds(outp) || tiles[outp.y]![outp.x] !== 'void') continue;
      out.push({ roomId: room.id, roomTile: p, doorTile: room.walled ? p : null, voidTile: outp, side });
    }
  }
  return out;
}

const manhattan = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const key = (p: Point) => `${p.x},${p.y}`;

/** Minimal binary min-heap keyed by priority, so A* scales to the 128x96 perf budget. */
class MinHeap<T> {
  private items: { p: number; v: T }[] = [];
  get size(): number {
    return this.items.length;
  }
  push(p: number, v: T): void {
    const items = this.items;
    items.push({ p, v });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent]!.p <= items[i]!.p) break;
      [items[parent], items[i]] = [items[i]!, items[parent]!];
      i = parent;
    }
  }
  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = i * 2 + 2;
        let smallest = i;
        if (l < items.length && items[l]!.p < items[smallest]!.p) smallest = l;
        if (r < items.length && items[r]!.p < items[smallest]!.p) smallest = r;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i]!, items[smallest]!];
        i = smallest;
      }
    }
    return top.v;
  }
}

/**
 * A* over `void` tiles only (corridors.ts step 6: "run A* over void tiles"). Cost 1 per step, +2 when
 * next to a wall (biases corridors toward the middle of open void, away from room walls).
 *
 * `maxExpansions` bounds the search (default: one visit per tile in the grid, `cols * rows`) so a
 * pathological layout with a huge or maze-like void area can't make a single call scan far more than
 * the grid's own size before giving up — security/perf hardening alongside `findVoidAreas`, which
 * lets most doomed calls (start and goal in different, disconnected void areas) skip this entirely.
 */
export function astarVoid(tiles: readonly TileKind[][], start: Point, goal: Point, maxExpansions?: number): Point[] | null {
  const rows = tiles.length;
  const cols = tiles[0]?.length ?? 0;
  const limit = maxExpansions ?? rows * cols;
  const passable = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows && tiles[p.y]![p.x] === 'void';
  if (!passable(start) || !passable(goal)) return null;

  const nearWall = (p: Point): boolean => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (n.x < 0 || n.y < 0 || n.x >= cols || n.y >= rows) continue;
      if (tiles[n.y]![n.x] === 'wall') return true;
    }
    return false;
  };

  const gScore = new Map<string, number>([[key(start), 0]]);
  const cameFrom = new Map<string, Point>();
  const closed = new Set<string>();
  const open = new MinHeap<Point>();
  open.push(manhattan(start, goal), start);
  let expansions = 0;

  while (open.size) {
    const current = open.pop()!;
    const currentKey = key(current);
    if (closed.has(currentKey)) continue;
    if (current.x === goal.x && current.y === goal.y) {
      const path: Point[] = [current];
      let ck = currentKey;
      while (cameFrom.has(ck)) {
        const prev = cameFrom.get(ck)!;
        path.push(prev);
        ck = key(prev);
      }
      return path.reverse();
    }
    if (++expansions > limit) return null;
    closed.add(currentKey);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { x: current.x + dx, y: current.y + dy };
      if (!passable(n)) continue;
      const nk = key(n);
      if (closed.has(nk)) continue;
      const stepCost = 1 + (nearWall(n) ? 2 : 0);
      const tentative = (gScore.get(currentKey) ?? Infinity) + stepCost;
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        cameFrom.set(nk, current);
        gScore.set(nk, tentative);
        open.push(tentative + manhattan(n, goal), n);
      }
    }
  }
  return null;
}

/** Widen a void-only path into `width` tiles of floor, perpendicular to local travel direction. */
export function carveCorridor(tiles: TileKind[][], roomAt: (string | null)[][], path: readonly Point[], width: number): void {
  const rows = tiles.length;
  const cols = tiles[0]?.length ?? 0;
  const carve = (p: Point) => {
    if (p.x < 0 || p.y < 0 || p.x >= cols || p.y >= rows) return;
    if (tiles[p.y]![p.x] === 'void') {
      tiles[p.y]![p.x] = 'floor';
      roomAt[p.y]![p.x] = null;
    }
  };
  const before = Math.floor((width - 1) / 2);
  const after = width - 1 - before;
  for (let i = 0; i < path.length; i++) {
    const cur = path[i]!;
    const ref = path[i + 1] ?? path[i - 1] ?? cur;
    const horizontal = ref.y === cur.y; // travelling along x -> widen along y, and vice versa
    for (let k = -before; k <= after; k++) {
      carve(horizontal ? { x: cur.x, y: cur.y + k } : { x: cur.x + k, y: cur.y });
    }
  }
}
