import { resolveZone, type RoomType, type Zone } from '@tagconn/shared';
import type { GeneratedMap, Point } from './procgen/types';

const key = (p: Point) => `${p.x},${p.y}`;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface Assignment extends Point {
  zone: Zone;
  /** true when the agent got a proper seat, false for a fallback tile. */
  seated: boolean;
}

/**
 * Restricts `assign` to one Multiverse realm (docs/design/living-office.md section 6.3, section 7):
 * without this, `GeneratedMap.zones` merges every room of a type across the *whole* map, so e.g. a
 * qa-engineer from project A could sit in project B's `qa-lab`.
 */
export interface SeatScope {
  /** Room ids that belong to this realm (`MultiverseRealm.roomIds`). */
  roomIds: ReadonlySet<string>;
  /** Room types actually present in this realm (the fixed 5-room template), for `resolveZone`. */
  types: ReadonlySet<RoomType>;
  /** The realm floor tile nearest the Nexus, reachable from the spawn — used for `entrance` (new
   *  characters walk in from here) and as the last-resort fallback when the realm is completely full. */
  gate: Point;
}

/**
 * Hands out one tile per agent. Prefers a free seat in the requested zone, then any free tile in
 * that zone, then the nearest free walkable tile. With a `scope` (the Multiverse), seats and tiles
 * are drawn only from that realm's own rooms instead of `map.zones`' whole-map merge.
 */
export class SeatAllocator {
  private byKey = new Map<string, Assignment>();
  private taken = new Map<string, string>(); // tile key -> holder's key

  constructor(private map: GeneratedMap) {}

  get(actorKey: string): Assignment | undefined {
    return this.byKey.get(actorKey);
  }

  occupant(p: Point): string | undefined {
    return this.taken.get(key(p));
  }

  assign(actorKey: string, zone: Zone, scope?: SeatScope): Assignment {
    const current = this.byKey.get(actorKey);
    if (current && current.zone === zone) return current;
    this.release(actorKey);
    const free = (p: Point) => !this.taken.has(key(p));

    let spot: Assignment | undefined;
    if (scope) {
      // `entrance` has no room of its own inside a realm block (only the Nexus does) — new arrivals
      // and agents heading "out" both walk to the realm's gate onto the rift bridge instead.
      if (zone === 'entrance') {
        spot = { ...scope.gate, zone, seated: false };
      } else {
        const resolved = resolveZone(zone, scope.types);
        const rooms = this.map.rooms.filter((r) => scope.roomIds.has(r.id) && r.type === resolved);
        const seats = rooms.flatMap((r) => r.seats);
        const tiles = rooms.flatMap((r) => r.tiles);
        spot = this.pickFromPool(actorKey, zone, seats, tiles, free);
        if (!spot) {
          const rect = rooms[0]?.interior;
          const center = rect ? { x: rect.x + Math.floor(rect.w / 2), y: rect.y + Math.floor(rect.h / 2) } : scope.gate;
          const near = this.nearestFree(center, scope.roomIds);
          spot = { ...(near ?? scope.gate), zone, seated: false };
        }
      }
    } else {
      const info = this.map.zones[zone];
      spot = this.pickFromPool(actorKey, zone, info.seats, info.tiles, free);
      if (!spot) {
        const r = info.rect;
        const near = this.nearestFree({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });
        spot = { ...(near ?? this.map.spawn), zone, seated: false };
      }
    }
    this.byKey.set(actorKey, spot);
    this.taken.set(key(spot), actorKey);
    return spot;
  }

  private pickFromPool(actorKey: string, zone: Zone, seats: readonly Point[], tiles: readonly Point[], free: (p: Point) => boolean): Assignment | undefined {
    if (seats.length) {
      const start = hash(actorKey) % seats.length;
      for (let i = 0; i < seats.length; i++) {
        const s = seats[(start + i) % seats.length]!;
        if (free(s)) return { x: s.x, y: s.y, zone, seated: true };
      }
    }
    const t = tiles.find(free);
    return t ? { x: t.x, y: t.y, zone, seated: false } : undefined;
  }

  release(actorKey: string): void {
    const a = this.byKey.get(actorKey);
    if (!a) return;
    this.byKey.delete(actorKey);
    if (this.taken.get(key(a)) === actorKey) this.taken.delete(key(a));
  }

  clear(): void {
    this.byKey.clear();
    this.taken.clear();
  }

  /** BFS outward from `from` over walkable tiles for the first unoccupied one. `within`, when given
   *  (the Multiverse), restricts the search to tiles belonging to one of those room ids, so a full
   *  realm overflows to its own gate rather than leaking into a neighboring realm's free tiles. */
  private nearestFree(from: Point, within?: ReadonlySet<string>): Point | undefined {
    const { walkable, cols, rows, roomAt } = this.map;
    const seen = new Set<string>();
    const queue: Point[] = [from];
    seen.add(key(from));
    while (queue.length) {
      const p = queue.shift()!;
      if (walkable[p.y]?.[p.x] === 0 && !this.taken.has(key(p))) {
        const roomId = roomAt[p.y]?.[p.x] ?? null;
        if (!within || (roomId !== null && within.has(roomId))) return p;
      }
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const n = { x: p.x + dx, y: p.y + dy };
        if (n.x < 0 || n.y < 0 || n.x >= cols || n.y >= rows || seen.has(key(n))) continue;
        seen.add(key(n));
        queue.push(n);
      }
    }
    return undefined;
  }
}
