import type { Zone } from '@tagconn/shared';
import type { OfficeMap, Point } from './map/officeMap';

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
 * Hands out one tile per agent. Prefers a free seat in the requested zone,
 * then any free tile in that zone, then the nearest free walkable tile.
 */
export class SeatAllocator {
  private byAgent = new Map<string, Assignment>();
  private taken = new Map<string, string>(); // tile key -> agent id

  constructor(private map: OfficeMap) {}

  get(agentId: string): Assignment | undefined {
    return this.byAgent.get(agentId);
  }

  occupant(p: Point): string | undefined {
    return this.taken.get(key(p));
  }

  assign(agentId: string, zone: Zone): Assignment {
    const current = this.byAgent.get(agentId);
    if (current && current.zone === zone) return current;
    this.release(agentId);
    const info = this.map.zones[zone];
    const free = (p: Point) => !this.taken.has(key(p));

    let spot: Assignment | undefined;
    const seats = info.seats;
    if (seats.length) {
      const start = hash(agentId) % seats.length;
      for (let i = 0; i < seats.length && !spot; i++) {
        const s = seats[(start + i) % seats.length]!;
        if (free(s)) spot = { x: s.x, y: s.y, zone, seated: true };
      }
    }
    if (!spot) {
      const t = info.tiles.find(free);
      if (t) spot = { x: t.x, y: t.y, zone, seated: false };
    }
    if (!spot) {
      const r = info.rect;
      const near = this.nearestFree({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });
      spot = { ...(near ?? this.map.spawn), zone, seated: false };
    }
    this.byAgent.set(agentId, spot);
    this.taken.set(key(spot), agentId);
    return spot;
  }

  release(agentId: string): void {
    const a = this.byAgent.get(agentId);
    if (!a) return;
    this.byAgent.delete(agentId);
    if (this.taken.get(key(a)) === agentId) this.taken.delete(key(a));
  }

  clear(): void {
    this.byAgent.clear();
    this.taken.clear();
  }

  /** BFS outward from `from` over walkable tiles for the first unoccupied one. */
  private nearestFree(from: Point): Point | undefined {
    const { walkable, cols, rows } = this.map;
    const seen = new Set<string>();
    const queue: Point[] = [from];
    seen.add(key(from));
    while (queue.length) {
      const p = queue.shift()!;
      if (walkable[p.y]?.[p.x] === 0 && !this.taken.has(key(p))) return p;
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
