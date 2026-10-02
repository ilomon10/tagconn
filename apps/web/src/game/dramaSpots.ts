// M12 G1: where an idle antic's cast stands (docs/design/game-office.md section 2.3 step 3). Pure: no Phaser.
import { coveredTileRect } from './procgen/geometry';
import type { GeneratedMap, PlacedFurniture, Point } from './procgen/types';

type Side = 'n' | 's' | 'e' | 'w';
type Spot = Point & { side: Side };

const OPPOSITE: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };

/**
 * Up to `count` tiles to stand on for `prop`: walkable, 4-adjacent to its footprint, in the same room, and
 * `isFree`. Sorted by distance to the footprint centre then (y, x), so the result is deterministic. For a
 * pair the second spot prefers the opposite side, then an adjacent side, then the same side. M15: the ring
 * goes around the integer tiles the prop covers (a half-offset pin blocks every tile it touches).
 */
export function gatherSpots(map: Pick<GeneratedMap, 'walkable' | 'roomAt'>, footprint: Pick<PlacedFurniture, 'x' | 'y' | 'w' | 'h' | 'roomId'>, count: 1 | 2, isFree: (p: Point) => boolean): Point[] {
  const prop = { ...coveredTileRect(footprint), roomId: footprint.roomId };
  const cands: Spot[] = [];
  const add = (x: number, y: number, side: Side) => {
    if (map.walkable[y]?.[x] !== 0 || map.roomAt[y]?.[x] !== prop.roomId) return;
    if (!isFree({ x, y })) return;
    cands.push({ x, y, side });
  };
  for (let dx = 0; dx < prop.w; dx++) {
    add(prop.x + dx, prop.y - 1, 'n');
    add(prop.x + dx, prop.y + prop.h, 's');
  }
  for (let dy = 0; dy < prop.h; dy++) {
    add(prop.x - 1, prop.y + dy, 'w');
    add(prop.x + prop.w, prop.y + dy, 'e');
  }
  const cx = prop.x + (prop.w - 1) / 2;
  const cy = prop.y + (prop.h - 1) / 2;
  const dist = (p: Point) => Math.abs(p.x - cx) + Math.abs(p.y - cy);
  cands.sort((a, b) => dist(a) - dist(b) || a.y - b.y || a.x - b.x);
  const first = cands[0];
  if (!first) return [];
  if (count === 1) return [{ x: first.x, y: first.y }];
  const rank = (s: Spot) => (s.side === OPPOSITE[first.side] ? 0 : s.side === first.side ? 2 : 1);
  const rest = cands.slice(1).sort((a, b) => rank(a) - rank(b) || cands.indexOf(a) - cands.indexOf(b));
  const second = rest[0];
  return second ? [{ x: first.x, y: first.y }, { x: second.x, y: second.y }] : [{ x: first.x, y: first.y }];
}
