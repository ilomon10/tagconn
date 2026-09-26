import type { GeneratedMap, Point } from '../procgen/types';

/**
 * W3b: where the Receptionist NPC (`spawnReceptionist`) stands on a floor. Every generated map has
 * exactly one `'entrance'` room (bsp.ts's `entranceIdx` / generate.ts's fixed entrance recipe), and
 * on the Multiverse floor the Nexus's own plaza is built as that same room type (`multiverse/plan.ts`
 * `nexus-entrance`, `type: 'entrance'`) — so this one function places the NPC both "next to the
 * entrance" on a normal floor and "at the Nexus gate" on the Multiverse, with no floor-kind branch.
 *
 * Picked tile is always inside the entrance room and never a seat, a door, or `map.spawn` (new
 * characters walk in there). It prefers a tile the entrance's own `reception-desk` furniture already
 * occupies (recipes.ts's `case 'entrance'` always places one, regardless of density) — those tiles
 * are `blocking: true`, so `map.walkable` already marks them unwalkable there: standing the NPC on
 * one can never block a real path or a seat, by construction, and it reads as "behind the counter".
 * Falls back to any other furniture-blocked entrance tile, then to a free floor tile, then to
 * `map.spawn` itself if the entrance room is somehow missing (shouldn't happen).
 *
 * Pure and deterministic: the same `GeneratedMap` always yields the same `Point`, so a rebuild that
 * regenerates an identical map (same layout id/seed) never moves the NPC, and callers don't need to
 * memoize anything themselves.
 */
export function pickReceptionistSpot(map: GeneratedMap): Point {
  const room = map.rooms.find((r) => r.type === 'entrance');
  if (!room) return map.spawn;

  const isSpawn = (p: Point) => p.x === map.spawn.x && p.y === map.spawn.y;

  // `room.tiles` only lists tiles the global reachability pass (`generate.ts`'s final verify step)
  // kept, which EXCLUDES anything a blocking furniture item later covers (the reception desk's own
  // tiles never make it in) — so this room's full interior is rebuilt straight from `map.roomAt`
  // instead, in a fixed row-major order for determinism.
  const roomTiles: Point[] = [];
  for (let y = room.interior.y; y < room.interior.y + room.interior.h; y++) {
    for (let x = room.interior.x; x < room.interior.x + room.interior.w; x++) {
      if (map.roomAt[y]?.[x] === room.id) roomTiles.push({ x, y });
    }
  }

  const deskTiles = new Set<string>();
  for (const f of map.furniture) {
    if (f.roomId !== room.id || f.kind !== 'reception-desk') continue;
    for (let x = f.x; x < f.x + f.w; x++) for (let y = f.y; y < f.y + f.h; y++) deskTiles.add(tileKey({ x, y }));
  }

  const blocked = roomTiles.filter((t) => map.walkable[t.y]?.[t.x] === 1 && !isSpawn(t));
  const onDesk = blocked.find((t) => deskTiles.has(tileKey(t)));
  if (onDesk) return onDesk;
  if (blocked[0]) return blocked[0];

  // No blocking furniture at all in the entrance (the recipe should always add one) — fall back to
  // any floor tile that isn't a seat, a door, or spawn.
  const seatTiles = new Set(room.seats.map(tileKey));
  const doorTiles = new Set(map.doors.filter((d) => d.roomId === room.id).map(tileKey));
  const open = roomTiles.find((t) => !seatTiles.has(tileKey(t)) && !doorTiles.has(tileKey(t)) && !isSpawn(t));
  return open ?? map.spawn;
}

function tileKey(p: Point): string {
  return `${p.x},${p.y}`;
}
