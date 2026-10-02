import { WAITING_CLEARANCE_TILES } from '../cosmetic/types';
import { coveredTileRect, coveredTiles } from '../procgen/geometry';
import type { GeneratedMap, PlacedFurniture, Point } from '../procgen/types';

type Grid = Pick<GeneratedMap, 'walkable' | 'roomAt'>;
type Footprint = Pick<PlacedFurniture, 'x' | 'y' | 'w' | 'h' | 'roomId'>;

const open = (map: Grid, roomId: string, p: Point): boolean =>
  map.walkable[p.y]?.[p.x] === 0 && map.roomAt[p.y]?.[p.x] === roomId;

/** Up to `count` free tiles 4-adjacent to the footprint in the same room, ordered around it clockwise from the
 *  north-west corner; deterministic. M15: the ring surrounds the integer tiles the footprint covers. */
export function ringSpots(map: Grid, footprint: Footprint, count: number, isFree: (p: Point) => boolean): Point[] {
  const prop = coveredTileRect(footprint);
  const ring: Point[] = [];
  for (let x = prop.x; x < prop.x + prop.w; x++) ring.push({ x, y: prop.y - 1 });
  for (let y = prop.y; y < prop.y + prop.h; y++) ring.push({ x: prop.x + prop.w, y });
  for (let x = prop.x + prop.w - 1; x >= prop.x; x--) ring.push({ x, y: prop.y + prop.h });
  for (let y = prop.y + prop.h - 1; y >= prop.y; y--) ring.push({ x: prop.x - 1, y });
  const out: Point[] = [];
  for (const p of ring) {
    if (out.length >= count) break;
    if (open(map, footprint.roomId, p) && isFree(p)) out.push(p);
  }
  return out;
}

/** Blocking prop → ringSpots; non-blocking (sofa, rug) → its own free footprint tiles first, then the ring. */
export function propSpots(map: Grid, prop: PlacedFurniture, count: number, isFree: (p: Point) => boolean): Point[] {
  if (prop.blocking) return ringSpots(map, prop, count, isFree);
  const out: Point[] = [];
  for (const p of coveredTiles(prop)) {
    if (out.length >= count) break;
    if (open(map, prop.roomId, p) && isFree(p)) out.push(p);
  }
  if (out.length < count) {
    const seen = new Set(out.map((p) => `${p.x},${p.y}`));
    for (const p of ringSpots(map, prop, count, isFree)) {
      if (out.length >= count) break;
      if (!seen.has(`${p.x},${p.y}`)) out.push(p);
    }
  }
  return out;
}

/** A free tile within `radius` (Manhattan) of `from` in the same room (straggler dawdle). */
export function nearbySpot(map: Grid, from: Point, radius: number, rand: () => number, isFree: (p: Point) => boolean): Point | null {
  const roomId = map.roomAt[from.y]?.[from.x];
  if (!roomId) return null;
  const cands: Point[] = [];
  for (let y = from.y - radius; y <= from.y + radius; y++) {
    for (let x = from.x - radius; x <= from.x + radius; x++) {
      if (x === from.x && y === from.y) continue;
      if (Math.abs(x - from.x) + Math.abs(y - from.y) > radius) continue;
      const p = { x, y };
      if (open(map, roomId, p) && isFree(p)) cands.push(p);
    }
  }
  return cands.length ? cands[Math.floor(rand() * cands.length)]! : null;
}

export function sitTiles(map: Pick<GeneratedMap, 'rooms'>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const r of map.rooms) for (const s of r.seats) if (s.kind === 'sit') out.add(`${s.x},${s.y}`);
  return out;
}

export function nearWaiting(p: Point, waiting: readonly Point[], r: number = WAITING_CLEARANCE_TILES): boolean {
  return waiting.some((w) => Math.max(Math.abs(w.x - p.x), Math.abs(w.y - p.y)) <= r);
}
