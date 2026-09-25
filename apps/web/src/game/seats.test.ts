import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, MULTIVERSE_LIMITS, type MultiverseProjectInput, type RoomType } from '@tagconn/shared';
import { generateMap } from './procgen';
import { planMultiverse } from './multiverse/plan';
import { SeatAllocator, type SeatScope } from './seats';
import { PathFinder } from './pathfinding';

// `seats.ts` and `pathfinding.ts` were retyped from the pre-M7 `OfficeMap` to procgen's
// `GeneratedMap` (M7 7e) — same shape (`zones`, `walkable`, `spawn`), so these behavioral tests
// (allocation, release, fallback, reachability) are unchanged; only the map source changed. Seat
// *count* parity with the pre-M7 map is covered by `procgen/__tests__/generate.test.ts` instead.
describe('SeatAllocator', () => {
  const map = generateMap(DEFAULT_LAYOUT);

  it('gives distinct seats to agents in the same zone', () => {
    const seats = new SeatAllocator(map);
    const spots = ['a', 'b', 'c', 'd', 'e'].map((id) => seats.assign(id, 'desks'));
    expect(new Set(spots.map((s) => `${s.x},${s.y}`)).size).toBe(5);
    expect(spots.every((s) => s.seated && s.zone === 'desks')).toBe(true);
  });

  it('keeps the same seat while the zone does not change', () => {
    const seats = new SeatAllocator(map);
    const a = seats.assign('a', 'qa-lab');
    expect(seats.assign('a', 'qa-lab')).toEqual(a);
    const b = seats.assign('a', 'library');
    expect(b.zone).toBe('library');
    expect(seats.occupant(a)).toBeUndefined();
    expect(seats.occupant(b)).toBe('a');
  });

  it('falls back to free tiles, then to nearby tiles, when a zone is full', () => {
    const seats = new SeatAllocator(map);
    const zone = map.zones['review-booth'];
    const total = zone.tiles.length + 5;
    const spots = Array.from({ length: total }, (_, i) => seats.assign(`agent-${i}`, 'review-booth'));
    const keys = spots.map((s) => `${s.x},${s.y}`);
    expect(new Set(keys).size).toBe(total);
    expect(spots.filter((s) => s.seated)).toHaveLength(zone.seats.length);
    expect(spots.every((s) => map.walkable[s.y]?.[s.x] === 0)).toBe(true);
  });

  it('release frees the seat for the next agent', () => {
    const seats = new SeatAllocator(map);
    const n = map.zones['pm-office'].seats.length;
    const first = Array.from({ length: n }, (_, i) => seats.assign(`p${i}`, 'pm-office'));
    seats.release('p0');
    const again = seats.assign('newcomer', 'pm-office');
    expect(again.seated).toBe(true);
    expect(`${again.x},${again.y}`).toBe(`${first[0]!.x},${first[0]!.y}`);
  });
});

// Realm-scoped seats (M8 8h, docs/design/living-office.md section 6.3 + 7): two realms from a real
// `planMultiverse` plan, so `SeatScope` is exercised against the same room ids/types the scene would
// build from `MultiversePlan.realms`.
describe('SeatAllocator realm scoping', () => {
  const NOW = 1_000_000;
  function project(i: number): MultiverseProjectInput {
    return { id: `p${i}`, name: `Project ${i}`, style: 'guild', createdAt: i, lastActivityAt: NOW, liveAgents: 1, lastLiveAt: NOW };
  }
  const plan = planMultiverse([project(0), project(1)], { maxRealms: MULTIVERSE_LIMITS.maxRealms, floorOrder: 'created', now: NOW, idleLeaveSec: 300 });
  const map = generateMap(plan.layout);

  function scopeFor(realmIndex: number): SeatScope {
    const realm = plan.realms.find((r) => r.index === realmIndex)!;
    const roomIds = new Set(realm.roomIds);
    const rooms = map.rooms.filter((r) => roomIds.has(r.id));
    const types = new Set<RoomType>(rooms.map((r) => r.type));
    // A stand-in gate for these tests: any reachable tile of the realm's own desks room.
    const gate = rooms.find((r) => r.type === 'desks')!.tiles[0]!;
    return { roomIds, types, gate };
  }

  it('only ever seats agents inside the requested realm, never a neighboring one', () => {
    const seats = new SeatAllocator(map);
    const scope0 = scopeFor(0);
    const realm0RoomIds = scope0.roomIds;
    const spots = Array.from({ length: 20 }, (_, i) => seats.assign(`agent-${i}`, 'desks', scope0));
    for (const s of spots) {
      const roomId = map.roomAt[s.y]?.[s.x];
      expect(roomId, `(${s.x},${s.y}) has no room`).not.toBeNull();
      expect(realm0RoomIds.has(roomId!)).toBe(true);
    }
  });

  it('resolves a zone missing from the realm template to its fallback within the same realm', () => {
    const seats = new SeatAllocator(map);
    const scope1 = scopeFor(1);
    // `qa-lab` isn't one of the 5 realm rooms; it falls back to `desks` (ZONE_FALLBACKS).
    const spot = seats.assign('qa-agent', 'qa-lab', scope1);
    const roomId = map.roomAt[spot.y]?.[spot.x];
    expect(roomId).toBe(`r1-desks`);
  });

  it('routes `entrance` to the realm gate instead of the whole map spawn', () => {
    const seats = new SeatAllocator(map);
    const scope0 = scopeFor(0);
    const spot = seats.assign('newcomer', 'entrance', scope0);
    expect(spot).toEqual({ ...scope0.gate, zone: 'entrance', seated: false });
  });

  it('falls back to a nearby tile within the same realm when its rooms are full', () => {
    const seats = new SeatAllocator(map);
    const scope0 = scopeFor(0);
    const roomIds = scope0.roomIds;
    const roomsOfType = map.rooms.filter((r) => roomIds.has(r.id) && r.type === 'desks');
    const total = roomsOfType.flatMap((r) => r.tiles).length + 3;
    const spots = Array.from({ length: total }, (_, i) => seats.assign(`d${i}`, 'desks', scope0));
    for (const s of spots) {
      const roomId = map.roomAt[s.y]?.[s.x];
      expect(roomId && roomIds.has(roomId)).toBe(true);
    }
    expect(new Set(spots.map((s) => `${s.x},${s.y}`)).size).toBe(total);
  });
});

describe('PathFinder', () => {
  const map = generateMap(DEFAULT_LAYOUT);
  const finder = new PathFinder(map.walkable);

  it('finds a path from the entrance to a seat in every zone', () => {
    for (const info of Object.values(map.zones)) {
      const seat = info.seats[0]!;
      const path = finder.find(map.spawn, seat);
      expect(path, info.zone).not.toBeNull();
      expect(path!.at(-1)).toEqual({ x: seat.x, y: seat.y });
      expect(path!.every((p) => map.walkable[p.y]?.[p.x] === 0)).toBe(true);
    }
  });

  it('returns null for blocked targets', () => {
    expect(finder.find(map.spawn, { x: 0, y: 0 })).toBeNull();
  });
});
