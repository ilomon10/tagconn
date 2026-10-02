import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, type OfficeLayout } from '@tagconn/shared';
import { generateMap } from '../procgen/generate';
import { generateRandomLayout } from '../procgen/bsp';
import type { GeneratedMap } from '../procgen/types';
import { isReceptionDeskTile, pickReceptionistSpot } from './receptionistSpot';

/** Every assertion a placement must satisfy (task requirements): inside the entrance room, never on
 *  a seat, a door, or the spawn tile, and deterministic (calling twice on the same map agrees). */
function assertValidSpot(map: GeneratedMap) {
  const room = map.rooms.find((r) => r.type === 'entrance');
  expect(room, 'every generated map has an entrance room').toBeTruthy();

  const spot = pickReceptionistSpot(map);
  const again = pickReceptionistSpot(map);
  expect(again).toEqual(spot);

  const inRoom = map.roomAt[spot.y]?.[spot.x] === room!.id;
  expect(inRoom, `(${spot.x},${spot.y}) belongs to the entrance room`).toBe(true);

  const onSeat = room!.seats.some((s) => s.x === spot.x && s.y === spot.y);
  expect(onSeat, 'not on a seat').toBe(false);

  const onDoor = map.doors.some((d) => d.x === spot.x && d.y === spot.y);
  expect(onDoor, 'not on a door').toBe(false);

  expect(spot, 'not on the spawn tile').not.toEqual(map.spawn);

  // The task's preferred outcome: a tile the reception-desk furniture already blocks, so it can
  // never sit on a walkable aisle a character actually paths through.
  expect(map.walkable[spot.y]?.[spot.x], 'a non-walkable (furniture-blocked) tile').toBe(1);
}

describe('pickReceptionistSpot', () => {
  it('DEFAULT_LAYOUT: picks a stable, in-room, non-walkable tile', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    assertValidSpot(map);
  });

  it('DEFAULT_LAYOUT: lands on the entrance room\'s own reception-desk furniture', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const room = map.rooms.find((r) => r.type === 'entrance')!;
    const desk = map.furniture.find((f) => f.roomId === room.id && f.kind === 'reception-desk');
    expect(desk).toBeTruthy();
    const spot = pickReceptionistSpot(map);
    expect(spot.y).toBe(desk!.y);
    expect(spot.x).toBeGreaterThanOrEqual(desk!.x);
    expect(spot.x).toBeLessThan(desk!.x + desk!.w);
  });

  for (const seed of [1, 2, 3, 17, 42, 101]) {
    it(`generateRandomLayout seed ${seed}: picks a stable, in-room, non-walkable tile`, () => {
      const input = generateRandomLayout({ width: 48, height: 30, seed, background: 'hall' });
      const layout: OfficeLayout = {
        ...input,
        background: input.background ?? 'hall',
        corridorWidth: input.corridorWidth ?? 2,
        id: `s${seed}`,
        builtin: false,
        createdAt: 0,
        updatedAt: 0,
      };
      const map = generateMap(layout);
      assertValidSpot(map);
    });
  }

  it('is deterministic across two independently generated (but identical) maps', () => {
    const a = generateMap(DEFAULT_LAYOUT);
    const b = generateMap(DEFAULT_LAYOUT);
    expect(pickReceptionistSpot(a)).toEqual(pickReceptionistSpot(b));
  });

  it('falls back to spawn when there is no entrance room at all', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const noEntrance: GeneratedMap = { ...map, rooms: map.rooms.filter((r) => r.type !== 'entrance') };
    expect(pickReceptionistSpot(noEntrance)).toEqual(map.spawn);
  });
});

describe('isReceptionDeskTile', () => {
  it('is true for the picked spot on the default floor (she sits behind the counter) and false for the spawn tile', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    expect(isReceptionDeskTile(map, pickReceptionistSpot(map))).toBe(true);
    expect(isReceptionDeskTile(map, map.spawn)).toBe(false);
  });
});

describe('half-tile reception desks (M15)', () => {
  it('isReceptionDeskTile covers every tile a half-offset desk touches', () => {
    const map = { furniture: [{ kind: 'reception-desk', x: 2.5, y: 1, w: 2, h: 1 }] } as unknown as GeneratedMap;
    expect([1, 2, 3, 4, 5].map((x) => isReceptionDeskTile(map, { x, y: 1 }))).toEqual([false, true, true, true, false]);
    expect(isReceptionDeskTile(map, { x: 3, y: 2 })).toBe(false);
  });

  it('a pinned reception desk at x = 0.5 still seats the Receptionist behind the counter', () => {
    const entrance = DEFAULT_LAYOUT.rooms.find((r) => r.type === 'entrance')!;
    const layout: OfficeLayout = {
      ...DEFAULT_LAYOUT,
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === entrance.id ? { ...r, furniture: [{ kind: 'reception-desk', x: 0.5, y: 1, w: 3, h: 1 }] } : r)),
    };
    const map = generateMap(layout);
    expect(map.layoutId).toBe(layout.id);
    const desk = map.furniture.find((f) => f.pinned && f.kind === 'reception-desk');
    expect(desk).toBeTruthy();
    assertValidSpot(map);
    const spot = pickReceptionistSpot(map);
    expect(isReceptionDeskTile(map, spot)).toBe(true);
  });
});
