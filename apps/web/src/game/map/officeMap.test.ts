import { describe, expect, it } from 'vitest';
import { ZONES } from '@tagconn/shared';
import { MAP_COLS, MAP_ROWS, buildOfficeMap, reachableFrom, resolveZoneRects } from './officeMap';

describe('buildOfficeMap', () => {
  const map = buildOfficeMap();
  const reach = reachableFrom(map.walkable, map.spawn);

  it('has the expected dimensions and a walkable spawn', () => {
    expect(map.walkable).toHaveLength(MAP_ROWS);
    expect(map.walkable[0]).toHaveLength(MAP_COLS);
    expect(map.walkable[map.spawn.y]?.[map.spawn.x]).toBe(0);
  });

  it('gives every zone reachable, walkable seats', () => {
    for (const zone of ZONES) {
      const info = map.zones[zone];
      expect(info.seats.length, zone).toBeGreaterThan(0);
      expect(info.tiles.length, zone).toBeGreaterThan(0);
      for (const s of info.seats) {
        expect(map.walkable[s.y]?.[s.x], `${zone} seat ${s.x},${s.y}`).toBe(0);
        expect(reach.has(`${s.x},${s.y}`), `${zone} seat reachable`).toBe(true);
      }
    }
  });

  it('has enough desk seats for a busy team', () => {
    expect(map.zones.desks.seats.length).toBeGreaterThanOrEqual(20);
  });

  it('cuts a door into every walled room', () => {
    const walled = ZONES.filter((z) => map.zones[z].walled);
    expect(map.doors.length).toBe(walled.length * 2);
  });

  it('seats are unique across the map', () => {
    const all = ZONES.flatMap((z) => map.zones[z].seats.map((s) => `${s.x},${s.y}`));
    expect(new Set(all).size).toBe(all.length);
  });

  it('respects zone overrides and stays connected', () => {
    const custom = buildOfficeMap({ lounge: { x: 2, y: 22, w: 8, h: 6 }, bogus: { x: 1 } });
    expect(custom.zones.lounge.rect).toEqual({ x: 2, y: 22, w: 8, h: 6 });
    const r = reachableFrom(custom.walkable, custom.spawn);
    for (const zone of ZONES) expect(custom.zones[zone].seats.every((s) => r.has(`${s.x},${s.y}`))).toBe(true);
  });

  it('clamps out-of-range overrides into the map', () => {
    const rects = resolveZoneRects({ desks: { x: -5, y: 100, w: 999, h: 3 } });
    expect(rects.desks.x).toBeGreaterThanOrEqual(1);
    expect(rects.desks.y + rects.desks.h).toBeLessThanOrEqual(MAP_ROWS - 1);
    expect(rects.desks.x + rects.desks.w).toBeLessThanOrEqual(MAP_COLS - 1);
    const map2 = buildOfficeMap({ desks: { x: -5, y: 100, w: 999, h: 3 } });
    expect(map2.zones.desks.seats.length).toBeGreaterThan(0);
  });
});
