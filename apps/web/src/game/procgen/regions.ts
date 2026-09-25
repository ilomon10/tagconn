import type { Point, TileKind } from './types';

/**
 * A connected component of floor tiles. Each walled room's interior is isolated by its own wall
 * ring, so it is always its own region. Hall tiles and open (unwalled) rooms have no ring between
 * them, so a flood fill merges them: "open rooms join the hall they touch" (guild-hall.md section 4).
 */
export interface Region {
  id: number;
  /** Room ids whose floor tiles fall in this region (a walled room's region has exactly one). */
  roomIds: string[];
  /** True when at least one tile in the region has no room (background hall or carved corridor). */
  hasHall: boolean;
  tiles: Point[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Flood fill every `floor` tile into connected regions. `roomAt[y][x]` is the room id or null (hall). */
export function findRegions(tiles: readonly TileKind[][], roomAt: readonly (string | null)[][]): Region[] {
  const rows = tiles.length;
  const cols = tiles[0]?.length ?? 0;
  const seen: boolean[][] = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false));
  const regions: Region[] = [];

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (tiles[y]![x] !== 'floor' || seen[y]![x]) continue;
      const roomIds = new Set<string>();
      let hasHall = false;
      const regionTiles: Point[] = [];
      let minX = x;
      let minY = y;
      let maxX = x;
      let maxY = y;
      const queue: Point[] = [{ x, y }];
      seen[y]![x] = true;
      let head = 0; // index pointer instead of queue.shift(), which is O(n) per call on an array
      while (head < queue.length) {
        const p = queue[head++]!;
        regionTiles.push(p);
        const rid = roomAt[p.y]?.[p.x] ?? null;
        if (rid) roomIds.add(rid);
        else hasHall = true;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
        for (const [dx, dy] of DIRS) {
          const nx = p.x + dx;
          const ny = p.y + dy;
          if (nx < 0 || ny < 0 || ny >= rows || nx >= cols) continue;
          if (seen[ny]![nx] || tiles[ny]![nx] !== 'floor') continue;
          seen[ny]![nx] = true;
          queue.push({ x: nx, y: ny });
        }
      }
      regions.push({ id: regions.length, roomIds: [...roomIds], hasHall, tiles: regionTiles, minX, minY, maxX, maxY });
    }
  }
  return regions;
}

/** Build a `[y][x]` lookup from tile to region id (or null outside any region). */
export function buildRegionAtGrid(regions: readonly Region[], rows: number, cols: number): (number | null)[][] {
  const grid: (number | null)[][] = Array.from({ length: rows }, () => new Array<number | null>(cols).fill(null));
  for (const r of regions) for (const t of r.tiles) grid[t.y]![t.x] = r.id;
  return grid;
}

/** Room id -> region id, for every room that has at least one floor tile. */
export function buildRoomToRegion(regions: readonly Region[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of regions) for (const roomId of r.roomIds) map.set(roomId, r.id);
  return map;
}

export function regionCentroid(r: Region): Point {
  let sx = 0;
  let sy = 0;
  for (const t of r.tiles) {
    sx += t.x;
    sy += t.y;
  }
  return { x: sx / r.tiles.length, y: sy / r.tiles.length };
}

/**
 * Connected components of `void` tiles only, computed once up front (security/perf hardening: a
 * layout with many small, fully walled-in void pockets used to make the corridor carver run a full
 * A* search — `astarVoid` — between every nearest-region pair even when the two exits sit in
 * completely disconnected void areas, where it was always going to fail after exploring the whole
 * component. Two exits in different void areas can never be joined, so a caller (`generate.ts`'s
 * `tryCorridor`) can skip that doomed pathfinding call entirely just by comparing area ids.
 */
export function findVoidAreas(tiles: readonly TileKind[][]): (number | null)[][] {
  const rows = tiles.length;
  const cols = tiles[0]?.length ?? 0;
  const areas: (number | null)[][] = Array.from({ length: rows }, () => new Array<number | null>(cols).fill(null));
  let nextId = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (tiles[y]![x] !== 'void' || areas[y]![x] !== null) continue;
      const id = nextId++;
      const queue: Point[] = [{ x, y }];
      areas[y]![x] = id;
      let head = 0;
      while (head < queue.length) {
        const p = queue[head++]!;
        for (const [dx, dy] of DIRS) {
          const nx = p.x + dx;
          const ny = p.y + dy;
          if (nx < 0 || ny < 0 || ny >= rows || nx >= cols) continue;
          if (areas[ny]![nx] !== null || tiles[ny]![nx] !== 'void') continue;
          areas[ny]![nx] = id;
          queue.push({ x: nx, y: ny });
        }
      }
    }
  }
  return areas;
}

/** Breadth-first flood fill over walkable tiles (0 = walkable), shared by verification and seat fallback. */
export function reachableFrom(walkable: readonly number[][], start: Point): Set<string> {
  const seen = new Set<string>();
  const key = (p: Point) => `${p.x},${p.y}`;
  if (walkable[start.y]?.[start.x] !== 0) return seen;
  const queue: Point[] = [start];
  seen.add(key(start));
  let head = 0;
  while (head < queue.length) {
    const p = queue[head++]!;
    for (const [dx, dy] of DIRS) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (walkable[n.y]?.[n.x] !== 0) continue;
      const k = key(n);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return seen;
}
