import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, hasLayoutErrors, LAYOUT_LIMITS, ZONES, type OfficeLayout } from '@tagconn/shared';
import { generateMap } from '../generate';
import { reachableFrom } from '../regions';
import type { GeneratedMap } from '../types';

const errors = (map: GeneratedMap) => map.issues.filter((i) => i.severity === 'error');

describe('generateMap(DEFAULT_LAYOUT)', () => {
  const map = generateMap(DEFAULT_LAYOUT);

  it('has 0 errors and all 10 zones with seats', () => {
    expect(errors(map)).toEqual([]);
    for (const zone of ZONES) {
      expect(map.zones[zone].seats.length, zone).toBeGreaterThan(0);
    }
  });

  it('matches or exceeds the pre-M7 office seat counts per zone (the ±20% floor from the acceptance criteria)', () => {
    // Seat counts read from `buildOfficeMap()` (apps/web/src/game/map/officeMap.ts) before M7.
    const previous: Record<string, number> = {
      entrance: 12,
      'pm-office': 4,
      desks: 36,
      'meeting-room': 20,
      whiteboard: 9,
      'qa-lab': 6,
      'review-booth': 4,
      'server-room': 10,
      library: 14,
      lounge: 12,
    };
    for (const zone of ZONES) {
      expect(map.zones[zone].seats.length, zone).toBeGreaterThanOrEqual(Math.ceil(previous[zone]! * 0.8));
    }
  });

  it('every seat is reachable from spawn', () => {
    const reach = reachableFrom(map.walkable, map.spawn);
    for (const zone of ZONES) {
      for (const s of map.zones[zone].seats) {
        expect(reach.has(`${s.x},${s.y}`), `${zone} seat ${s.x},${s.y}`).toBe(true);
      }
    }
  });

  it('every stairs landing is reachable from spawn', () => {
    const reach = reachableFrom(map.walkable, map.spawn);
    for (const s of map.stairs) {
      expect(reach.has(`${s.landing.x},${s.landing.y}`), `stairs ${s.dir} landing`).toBe(true);
    }
  });

  it('every door touches floor (or another door tile, for a double-thick opening) on both sides', () => {
    const passable = (x: number, y: number) => {
      const t = map.tiles[y]?.[x];
      return t === 'floor' || t === 'door';
    };
    for (const d of map.doors) {
      const dx = d.vertical ? 1 : 0;
      const dy = d.vertical ? 0 : 1;
      expect(passable(d.x - dx, d.y - dy) || passable(d.x + dx, d.y + dy), `door at ${d.x},${d.y}`).toBe(true);
    }
  });

  it('no blocking furniture sits on a door tile', () => {
    const doorKeys = new Set(map.doors.map((d) => `${d.x},${d.y}`));
    for (const f of map.furniture) {
      if (!f.blocking) continue;
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) {
          expect(doorKeys.has(`${x},${y}`), `furniture ${f.kind} at ${x},${y}`).toBe(false);
        }
      }
    }
  });

  it('output is deterministic: generating the same layout twice gives an identical JSON result', () => {
    const again = generateMap(DEFAULT_LAYOUT);
    expect(JSON.stringify(again)).toBe(JSON.stringify(map));
  });

  it('moving one room leaves the furniture of the other rooms unchanged', () => {
    // Shift the lounge a little (still valid, no new neighbours) and compare every other room's furniture.
    const moved: OfficeLayout = {
      ...DEFAULT_LAYOUT,
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === 'lounge' ? { ...r, x: r.x + 1 } : r)),
    };
    const movedMap = generateMap(moved);
    expect(errors(movedMap)).toEqual([]);
    for (const roomId of ['pm-office', 'meeting-room', 'whiteboard', 'library', 'desks', 'review-booth', 'qa-lab', 'server-room']) {
      const before = map.furniture.filter((f) => f.roomId === roomId);
      const after = movedMap.furniture.filter((f) => f.roomId === roomId);
      expect(after, roomId).toEqual(before);
    }
  });
});

describe('generateMap: fallback zones', () => {
  it('a zone with no room aliases the ZoneInfo of its resolveZone() fallback target', () => {
    // Drop the library room; ZONE_FALLBACKS.library -> ['review-booth', ...], which is still present.
    const layout: OfficeLayout = { ...DEFAULT_LAYOUT, rooms: DEFAULT_LAYOUT.rooms.filter((r) => r.id !== 'library') };
    const map = generateMap(layout);
    expect(map.issues.some((i) => i.code === 'zone-missing' && i.message.includes('library'))).toBe(true);
    expect(map.zones.library).toEqual(map.zones['review-booth']);
  });
});

describe('generateMap: invalid layout', () => {
  it('falls back to the default map and reports the original issues', () => {
    const invalid: OfficeLayout = { ...DEFAULT_LAYOUT, rooms: [] }; // no entrance, no stairs -> errors
    const map = generateMap(invalid);
    expect(errors(map).length).toBeGreaterThan(0);
    expect(errors(map).some((i) => i.code === 'entrance-count')).toBe(true);
    expect(errors(map).some((i) => i.code === 'stairs-missing')).toBe(true);
    // The map itself is still the default map's geometry (same size as DEFAULT_LAYOUT).
    expect(map.cols).toBe(DEFAULT_LAYOUT.width);
    expect(map.rows).toBe(DEFAULT_LAYOUT.height);
    expect(map.zones.desks.seats.length).toBeGreaterThan(0);
  });

  it('too many rooms is reported as an error and still yields a usable map', () => {
    const extra = Array.from({ length: LAYOUT_LIMITS.maxRooms + 1 }, (_, i) => ({
      id: `extra${i}`,
      type: 'hall' as const,
      x: 0,
      y: 0,
      w: 2,
      h: 2,
    }));
    const invalid: OfficeLayout = { ...DEFAULT_LAYOUT, rooms: [...DEFAULT_LAYOUT.rooms, ...extra] };
    const map = generateMap(invalid);
    expect(errors(map).some((i) => i.code === 'too-many-rooms')).toBe(true);
    expect(map.spawn).toBeDefined();
  });
});

describe('generateMap: void background', () => {
  it('carves corridors that connect every room to spawn', () => {
    const layout: OfficeLayout = { ...DEFAULT_LAYOUT, background: 'void', corridorWidth: 2 };
    const map = generateMap(layout);
    expect(errors(map)).toEqual([]);
    const reach = reachableFrom(map.walkable, map.spawn);
    for (const room of map.rooms) {
      if (room.type === 'stairs' || room.type === 'hall') continue;
      expect(room.tiles.length, room.id).toBeGreaterThan(0);
      for (const t of room.tiles) expect(reach.has(`${t.x},${t.y}`), `${room.id} tile ${t.x},${t.y}`).toBe(true);
    }
  });
});
