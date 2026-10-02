import type { GeneratedMap, Point } from '../../game/procgen/types';

/** A random walkable tile other than `from` (the preview's wander target), or null when the map has none. */
export function pickWanderTile(map: GeneratedMap, from: Point, rng: () => number = Math.random): Point | null {
  const open: Point[] = [];
  for (let y = 0; y < map.rows; y++) {
    for (let x = 0; x < map.cols; x++) if (map.walkable[y]?.[x] === 0 && (x !== from.x || y !== from.y)) open.push({ x, y });
  }
  return open.length ? open[Math.floor(rng() * open.length)]! : null;
}
