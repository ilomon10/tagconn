import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, hasLayoutErrors, type LayoutRoom, type OfficeLayout } from '@tagconn/shared';
import { generateRandomLayout } from '../bsp';
import { generateMap } from '../generate';
import { APPLIANCE_MAX, APPLIANCE_SPECS, TALL_AGAINST_WALL_KINDS, type ApplianceKind } from '../backWallSpec';
import type { FurnitureKind, GeneratedMap, Point } from '../types';

const key = (p: Point) => `${p.x},${p.y}`;
const isApplianceKind = (k: FurnitureKind): k is ApplianceKind => Object.prototype.hasOwnProperty.call(APPLIANCE_SPECS, k);

/** Mirrors `recipes.ts`'s private `DECOR_KINDS` (M8 8n): the doc's parity rule (section 2.5) puts
 *  "non-blocking decor furniture" in the "may differ (visual only)" bucket - it shares its RNG stream
 *  with `decorateRoom`'s free-cell count, which shrinks whenever an appliance takes a cell, shifting
 *  later draws even though nothing about the recipe itself changed. */
const DECOR_ONLY_KINDS = new Set<FurnitureKind>(['plant', 'rug', 'lamp', 'crate', 'banner', 'wall-art', 'bin']);

/** Every cell any appliance in `map` occupies, as "x,y" keys. */
function applianceCells(map: GeneratedMap): Set<string> {
  const out = new Set<string>();
  for (const f of map.furniture) {
    if (!isApplianceKind(f.kind)) continue;
    for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) out.add(key({ x, y }));
  }
  return out;
}

/**
 * Parity sweep (docs/design/back-wall.md section 2.5): `generateMap(layout)` (backWall on, the
 * default) compared against `generateMap(layout, { backWall: false })` (== pre-8p output).
 */
function assertParity(layout: OfficeLayout, label: string): void {
  const withWalls = generateMap(layout);
  const without = generateMap(layout, { backWall: false });
  const applianceKeys = applianceCells(withWalls);

  // Nothing but appliance placement should ever put backWall:false in error where backWall:true
  // isn't, or vice versa - both must report the exact same issues.
  expect(withWalls.issues, `${label} issues`).toEqual(without.issues);

  // --- identical fields --------------------------------------------------------------------
  expect(withWalls.tiles, `${label} tiles`).toEqual(without.tiles);
  expect(withWalls.walls, `${label} walls`).toEqual(without.walls);
  expect(withWalls.doors, `${label} doors`).toEqual(without.doors);
  expect(withWalls.stairs, `${label} stairs`).toEqual(without.stairs);
  expect(withWalls.spawn, `${label} spawn`).toEqual(without.spawn);
  expect(withWalls.frontDoor, `${label} frontDoor`).toEqual(without.frontDoor);
  expect(withWalls.roomAt, `${label} roomAt`).toEqual(without.roomAt);
  expect(withWalls.zoneAt, `${label} zoneAt`).toEqual(without.zoneAt);
  expect(withWalls.reachability, `${label} reachability`).toEqual(without.reachability);

  // --- walkable/tiles differ only by appliance cells ----------------------------------------
  for (let y = 0; y < withWalls.rows; y++) {
    for (let x = 0; x < withWalls.cols; x++) {
      const k = key({ x, y });
      if (applianceKeys.has(k)) {
        expect(withWalls.walkable[y]![x], `${label} walkable ${k} (appliance)`).toBe(1);
        expect(without.walkable[y]![x], `${label} walkable(false) ${k} (appliance)`).toBe(0);
      } else {
        expect(withWalls.walkable[y]![x], `${label} walkable ${k}`).toBe(without.walkable[y]![x]);
      }
    }
  }

  // --- per-room: recipe furniture identical (minus appliances and `againstNorthWall`), sit
  // seats identical, and total seat count identical (guaranteed by the top-up count-parity rule) --
  for (const roomFalse of without.rooms) {
    const roomTrue = withWalls.rooms.find((r) => r.id === roomFalse.id)!;
    expect(roomTrue, `${label} room ${roomFalse.id} exists`).toBeDefined();

    const furnTrue = withWalls.furniture
      .filter((f) => f.roomId === roomFalse.id && !isApplianceKind(f.kind) && !DECOR_ONLY_KINDS.has(f.kind))
      .map(({ againstNorthWall: _ignored, ...rest }) => rest);
    const furnFalse = without.furniture
      .filter((f) => f.roomId === roomFalse.id && !DECOR_ONLY_KINDS.has(f.kind))
      .map(({ againstNorthWall: _ignored, ...rest }) => rest);
    expect(furnTrue, `${label} room ${roomFalse.id} recipe furniture`).toEqual(furnFalse);

    const sitTrue = roomTrue.seats.filter((s) => s.kind === 'sit');
    const sitFalse = roomFalse.seats.filter((s) => s.kind === 'sit');
    expect(sitTrue, `${label} room ${roomFalse.id} sit seats`).toEqual(sitFalse);
    expect(roomTrue.seats.length, `${label} room ${roomFalse.id} seat count`).toBe(roomFalse.seats.length);

    // tiles differ only by this room's appliance cells (no-split guarantees nothing else changes).
    const trueTiles = new Set(roomTrue.tiles.map(key));
    const falseTiles = new Set(roomFalse.tiles.map(key));
    for (const k of falseTiles) {
      if (applianceKeys.has(k)) expect(trueTiles.has(k), `${label} room ${roomFalse.id} tile ${k} dropped`).toBe(false);
      else expect(trueTiles.has(k), `${label} room ${roomFalse.id} tile ${k} kept`).toBe(true);
    }
    for (const k of trueTiles) expect(falseTiles.has(k), `${label} room ${roomFalse.id} tile ${k} not new`).toBe(true);
  }

  // --- per-zone seat counts identical --------------------------------------------------------
  for (const zone of Object.keys(without.zones) as (keyof typeof without.zones)[]) {
    expect(withWalls.zones[zone].seats.length, `${label} zone ${zone} seat count`).toBe(without.zones[zone].seats.length);
  }

  // --- a `decor: 0` room is byte-identical -----------------------------------------------------
  for (const room of layout.rooms) {
    const decor = room.furnish?.decor ?? layout.furnishDefaults?.decor ?? 0.35;
    if (decor !== 0) continue;
    const furnTrue = withWalls.furniture.filter((f) => f.roomId === room.id);
    const furnFalse = without.furniture.filter((f) => f.roomId === room.id);
    expect(furnTrue, `${label} decor:0 room ${room.id} furniture`).toEqual(furnFalse);
    expect(withWalls.northWall.filter((s) => s.roomId === room.id), `${label} decor:0 room ${room.id} northWall`).toEqual([]);
  }
}

/** Invariants every placed appliance must satisfy (docs/design/back-wall.md section 2.3/T1). */
function assertApplianceInvariants(map: GeneratedMap, label: string): void {
  for (const f of map.furniture) {
    if (!isApplianceKind(f.kind)) continue;
    const room = map.rooms.find((r) => r.id === f.roomId);
    expect(room, `${label} appliance ${f.kind}@${f.x},${f.y} has a room`).toBeDefined();
    expect(f.y, `${label} appliance ${f.kind}@${f.x},${f.y} on interior.y`).toBe(room!.interior.y);
    expect(f.blocking, `${label} appliance ${f.kind}@${f.x},${f.y} blocking`).toBe(true);
    expect(f.againstNorthWall, `${label} appliance ${f.kind}@${f.x},${f.y} againstNorthWall`).toBe(true);
    for (let x = f.x; x < f.x + f.w; x++) {
      expect(map.tiles[f.y - 1]?.[x], `${label} appliance ${f.kind}@${f.x},${f.y} north tile ${x}`).toBe('wall');
    }
    // Front cell walkable.
    for (let x = f.x; x < f.x + f.w; x++) {
      expect(map.walkable[f.y + 1]?.[x], `${label} appliance ${f.kind}@${f.x},${f.y} front cell ${x} walkable`).toBe(0);
    }
  }

  // Door-apron standoff: no appliance cell (or its immediate horizontal neighbour) sits on a door tile.
  const doorKeys = new Set(map.doors.map((d) => key(d)));
  for (const f of map.furniture) {
    if (!isApplianceKind(f.kind)) continue;
    for (let x = f.x - 1; x <= f.x + f.w; x++) {
      expect(doorKeys.has(key({ x, y: f.y })), `${label} appliance ${f.kind}@${f.x},${f.y} near door at col ${x}`).toBe(false);
    }
  }
}

/** Invariants every `northWall` slot must satisfy. */
function assertNorthWallInvariants(map: GeneratedMap, label: string): void {
  const doorKeys = new Set(map.doors.map((d) => key(d)));
  const applianceKeys = applianceCells(map);
  const tallColumnsByRoom = new Map<string, Set<number>>();
  for (const f of map.furniture) {
    if (isApplianceKind(f.kind) || (f.againstNorthWall && TALL_AGAINST_WALL_KINDS.has(f.kind))) {
      const set = tallColumnsByRoom.get(f.roomId) ?? new Set<number>();
      for (let x = f.x; x < f.x + f.w; x++) set.add(x);
      tallColumnsByRoom.set(f.roomId, set);
    }
  }
  const seenCells = new Map<string, Set<string>>(); // roomId -> occupied "x,y" (no overlap check)

  for (const slot of map.northWall) {
    const room = map.rooms.find((r) => r.id === slot.roomId)!;
    expect(room, `${label} northWall slot has a room`).toBeDefined();
    expect(slot.y, `${label} slot ${slot.kind}@${slot.x},${slot.y} on wall row`).toBe(room.interior.y - 1);
    const labelReserve = Math.min(3, Math.floor(room.interior.w / 3));
    expect(slot.x, `${label} slot ${slot.kind}@${slot.x},${slot.y} right of label reserve`).toBeGreaterThanOrEqual(
      room.interior.x + labelReserve,
    );
    const occupied = seenCells.get(slot.roomId) ?? new Set<string>();
    for (let x = slot.x; x < slot.x + slot.span; x++) {
      expect(map.tiles[slot.y]?.[x], `${label} slot ${slot.kind}@${slot.x} col ${x} is wall`).toBe('wall');
      expect(x, `${label} slot ${slot.kind}@${slot.x} col ${x} inside interior`).toBeLessThanOrEqual(room.interior.x + room.interior.w - 1);
      const k = key({ x, y: slot.y });
      expect(occupied.has(k), `${label} slot ${slot.kind}@${slot.x} col ${x} overlap`).toBe(false);
      occupied.add(k);
      for (const dx of [-1, 0, 1]) {
        expect(doorKeys.has(key({ x: x + dx, y: slot.y })), `${label} slot ${slot.kind}@${slot.x} col ${x} near door`).toBe(false);
      }
      expect(tallColumnsByRoom.get(slot.roomId)?.has(x) ?? false, `${label} slot ${slot.kind}@${slot.x} col ${x} over tall item`).toBe(
        false,
      );
      expect(applianceKeys.has(key({ x, y: room.interior.y })), `${label} slot ${slot.kind}@${slot.x} col ${x} over appliance floor`).toBe(
        false,
      );
    }
    seenCells.set(slot.roomId, occupied);
  }
}

describe('backWall parity (docs/design/back-wall.md section 2.5)', () => {
  it('DEFAULT_LAYOUT', () => {
    assertParity(DEFAULT_LAYOUT, 'DEFAULT_LAYOUT');
  });

  it('DEFAULT_LAYOUT: invariants hold for every appliance and northWall slot', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    assertApplianceInvariants(map, 'DEFAULT_LAYOUT');
    assertNorthWallInvariants(map, 'DEFAULT_LAYOUT');
  });

  it('DEFAULT_LAYOUT: at least 60% of eligible rooms get at least one appliance', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const eligibleRoomIds = new Set(
      map.furniture
        .filter((f) => isApplianceKind(f.kind))
        .map((f) => f.roomId),
    );
    const eligibleRoomsTotal = DEFAULT_LAYOUT.rooms.filter((r) => {
      const room = map.rooms.find((gr) => gr.id === r.id)!;
      return (
        r.type !== 'hall' &&
        r.type !== 'stairs' &&
        room.interior.w >= 4 &&
        room.interior.h >= 3 &&
        (r.furnish?.decor ?? DEFAULT_LAYOUT.furnishDefaults?.decor ?? 0.35) > 0
      );
    });
    expect(eligibleRoomsTotal.length, 'DEFAULT_LAYOUT eligible rooms exist').toBeGreaterThan(0);
    const withAppliance = eligibleRoomsTotal.filter((r) => eligibleRoomIds.has(r.id));
    expect(withAppliance.length / eligibleRoomsTotal.length).toBeGreaterThanOrEqual(0.6);
  });

  // Fixture layouts (representative, hand-built - the same style as furnish.test.ts / doors-explicit.test.ts).
  function fixture(room: LayoutRoom, extra?: Partial<OfficeLayout>): OfficeLayout {
    const entrance: LayoutRoom = { id: 'entrance', type: 'entrance', x: 1, y: 20, w: 6, h: 4 };
    const stairs: LayoutRoom = { id: 'stairs', type: 'stairs', x: 9, y: 20, w: 3, h: 3 };
    return {
      id: 'fixture', name: 'fixture', width: 26, height: 25, seed: 11, background: 'hall', corridorWidth: 2,
      builtin: false, createdAt: 0, updatedAt: 0,
      rooms: [room, entrance, stairs],
      ...extra,
    };
  }
  const FIXTURES: [string, OfficeLayout][] = [
    ['desks (normal)', fixture({ id: 'r', type: 'desks', x: 1, y: 1, w: 22, h: 16 })],
    ['server-room (packed)', fixture({ id: 'r', type: 'server-room', x: 1, y: 1, w: 20, h: 14, furnish: { density: 'packed' } })],
    ['library', fixture({ id: 'r', type: 'library', x: 1, y: 1, w: 18, h: 14 })],
    ['lounge', fixture({ id: 'r', type: 'lounge', x: 1, y: 1, w: 18, h: 12 })],
    ['entrance-as-room (meeting-room)', fixture({ id: 'r', type: 'meeting-room', x: 1, y: 1, w: 14, h: 12 })],
    ['pm-office', fixture({ id: 'r', type: 'pm-office', x: 1, y: 1, w: 16, h: 14 })],
    ['tiny room (below eligible size)', fixture({ id: 'r', type: 'review-booth', x: 1, y: 1, w: 5, h: 5 })],
    ['decor: 0', fixture({ id: 'r', type: 'desks', x: 1, y: 1, w: 20, h: 14, furnish: { decor: 0 } })],
  ];
  for (const [name, layout] of FIXTURES) {
    it(`fixture: ${name}`, () => {
      expect(hasLayoutErrors(generateMap(layout, { backWall: false }).issues)).toBe(false);
      assertParity(layout, name);
    });
  }

  // 300-seed BSP samples (both backgrounds), one representative size (48x30) to keep the sweep fast.
  for (const background of ['hall', 'void'] as const) {
    it(`300 BSP seeds at 48x30 (${background})`, () => {
      for (let seed = 1; seed <= 300; seed++) {
        const input = generateRandomLayout({ width: 48, height: 30, seed, background });
        const layout: OfficeLayout = {
          ...input,
          background: input.background ?? 'hall',
          corridorWidth: input.corridorWidth ?? 2,
          id: `bsp${seed}`,
          builtin: false,
          createdAt: 0,
          updatedAt: 0,
        };
        assertParity(layout, `bsp seed ${seed} (${background})`);
      }
    }, 60000);
  }
});

describe('backWall determinism', () => {
  it('generating the same layout twice is byte-identical', () => {
    const a = generateMap(DEFAULT_LAYOUT);
    const b = generateMap(DEFAULT_LAYOUT);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("changing one room's furnish.seed changes only that room's appliances/northWall", () => {
    const base: OfficeLayout = {
      ...DEFAULT_LAYOUT,
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === 'desks' ? { ...r, furnish: { seed: 1 } } : r)),
    };
    const rerolled: OfficeLayout = {
      ...DEFAULT_LAYOUT,
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === 'desks' ? { ...r, furnish: { seed: 2 } } : r)),
    };
    const mapA = generateMap(base);
    const mapB = generateMap(rerolled);
    expect(hasLayoutErrors(mapA.issues)).toBe(false);
    expect(hasLayoutErrors(mapB.issues)).toBe(false);
    for (const roomId of DEFAULT_LAYOUT.rooms.map((r) => r.id).filter((id) => id !== 'desks')) {
      expect(mapA.furniture.filter((f) => f.roomId === roomId), roomId).toEqual(mapB.furniture.filter((f) => f.roomId === roomId));
      expect(mapA.northWall.filter((s) => s.roomId === roomId), roomId).toEqual(mapB.northWall.filter((s) => s.roomId === roomId));
    }
  });
});

describe('backWall: APPLIANCE_MAX respected', () => {
  it('never places more appliances in a room than APPLIANCE_MAX[density] allows', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const perRoom = new Map<string, number>();
    for (const f of map.furniture) {
      if (!isApplianceKind(f.kind)) continue;
      perRoom.set(f.roomId, (perRoom.get(f.roomId) ?? 0) + 1);
    }
    for (const [roomId, count] of perRoom) {
      const spec = DEFAULT_LAYOUT.rooms.find((r) => r.id === roomId);
      const density = spec?.furnish?.density ?? DEFAULT_LAYOUT.furnishDefaults?.density ?? 'normal';
      expect(count, roomId).toBeLessThanOrEqual(APPLIANCE_MAX[density]);
    }
  });
});
