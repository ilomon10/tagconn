import { describe, expect, it } from 'vitest';
import { buildOfficeMap } from './map/officeMap';
import { SeatAllocator } from './seats';
import { PathFinder } from './pathfinding';

describe('SeatAllocator', () => {
  const map = buildOfficeMap();

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

describe('PathFinder', () => {
  const map = buildOfficeMap();
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
