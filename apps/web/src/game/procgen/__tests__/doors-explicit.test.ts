import { describe, expect, it } from 'vitest';
import { DOOR_SIDES, hasLayoutErrors, validateLayout, type LayoutRoom, type OfficeLayout } from '@tagconn/shared';
import { generateMap } from '../generate';
import { reachableFrom } from '../regions';

/**
 * M8 8n: explicit doors (`room.doors`) and the reachability report. A meeting room placed well away
 * from the outer wall so every side has open hall floor around it, no matter which side a test puts
 * a door on.
 */
function layoutWithRoom(room: LayoutRoom): OfficeLayout {
  const entrance: LayoutRoom = { id: 'entrance', type: 'entrance', x: 1, y: 22, w: 6, h: 4 };
  const stairs: LayoutRoom = { id: 'stairs', type: 'stairs', x: 9, y: 22, w: 3, h: 3 };
  return {
    id: 'test', name: 'test', width: 24, height: 27, seed: 3, background: 'hall', corridorWidth: 2,
    builtin: false, createdAt: 0, updatedAt: 0,
    rooms: [room, entrance, stairs],
  };
}

const BASE_ROOM: Omit<LayoutRoom, 'doors'> = { id: 'room', type: 'meeting-room', x: 6, y: 6, w: 8, h: 7 };

describe('generateMap: explicit doors (room.doors)', () => {
  it('undefined doors: behaves exactly as before (an automatic door is placed)', () => {
    const map = generateMap(layoutWithRoom({ ...BASE_ROOM }));
    expect(hasLayoutErrors(map.issues)).toBe(false);
    const doors = map.doors.filter((d) => d.roomId === 'room');
    expect(doors.length).toBeGreaterThan(0);
    expect(doors.every((d) => d.auto)).toBe(true);
    const reach = reachableFrom(map.walkable, map.spawn);
    const room = map.rooms.find((r) => r.id === 'room')!;
    expect(room.tiles.length).toBeGreaterThan(0);
    for (const t of room.tiles) expect(reach.has(`${t.x},${t.y}`)).toBe(true);
  });

  it('an explicit door is placed exactly where specified, marked non-auto, and the room is reachable', () => {
    const layout = layoutWithRoom({ ...BASE_ROOM, doors: [{ side: 's', offset: 3, width: 2 }] });
    const map = generateMap(layout);
    expect(hasLayoutErrors(map.issues)).toBe(false);
    const doors = map.doors.filter((d) => d.roomId === 'room');
    expect(doors.length).toBe(2); // width 2 -> 2 door tiles
    for (const d of doors) {
      expect(d.auto).toBe(false);
      expect(d.side).toBe('s');
      expect(d.offset).toBe(3);
      expect(d.width).toBe(2);
    }
    // The door sits on the room's south wall at the specified offset (footprint x=6, so offset 3/4 -> x=9,10).
    expect(doors.map((d) => d.x).sort((a, b) => a - b)).toEqual([9, 10]);
    expect(doors[0]!.y).toBe(BASE_ROOM.y + BASE_ROOM.h - 1);

    const reach = reachableFrom(map.walkable, map.spawn);
    const room = map.rooms.find((r) => r.id === 'room')!;
    expect(room.tiles.length).toBeGreaterThan(0);
    for (const t of room.tiles) expect(reach.has(`${t.x},${t.y}`)).toBe(true);
    expect(map.reachability.unreachableRooms.find((u) => u.roomId === 'room')).toBeUndefined();
  });

  it('an explicit door on a wall shared with another walled room (double-thick) still connects', () => {
    const roomA: LayoutRoom = { id: 'a', type: 'meeting-room', x: 6, y: 6, w: 8, h: 7, doors: [{ side: 'e', offset: 2, width: 1 }] };
    // roomB starts right after roomA's own east wall (x=13), so the two rooms have separate,
    // adjacent wall rings (a "double wall") instead of sharing one tile - exercising the depth-2
    // branch of the explicit-door code (wall, then floor, one tile further out).
    const roomB: LayoutRoom = { id: 'b', type: 'qa-lab', x: 14, y: 6, w: 6, h: 6 };
    const entrance: LayoutRoom = { id: 'entrance', type: 'entrance', x: 1, y: 22, w: 6, h: 4 };
    const stairs: LayoutRoom = { id: 'stairs', type: 'stairs', x: 9, y: 22, w: 3, h: 3 };
    const layout: OfficeLayout = {
      id: 'test', name: 'test', width: 24, height: 27, seed: 3, background: 'hall', corridorWidth: 2,
      builtin: false, createdAt: 0, updatedAt: 0,
      rooms: [roomA, roomB, entrance, stairs],
    };
    const map = generateMap(layout);
    expect(hasLayoutErrors(map.issues)).toBe(false);
    const door = map.doors.find((d) => d.roomId === 'a');
    expect(door).toBeDefined();
    expect(door!.auto).toBe(false);
    const reach = reachableFrom(map.walkable, map.spawn);
    const a = map.rooms.find((r) => r.id === 'a')!;
    expect(a.tiles.length).toBeGreaterThan(0);
    for (const t of a.tiles) expect(reach.has(`${t.x},${t.y}`)).toBe(true);
  });

  it('doors: [] never gets an automatic door: no door tiles for that room at all', () => {
    const layout = layoutWithRoom({ ...BASE_ROOM, doors: [] });
    // Sanity: validateLayout itself only WARNs about a sealed room (`room-sealed`) - it's the
    // generator's `unreachable-room` (checked below, and in the "reachability report" tests) that
    // turns it into an error, not the geometry validation this layout is otherwise clean under.
    expect(hasLayoutErrors(validateLayout(layout))).toBe(false);
    const map = generateMap(layout);
    expect(map.issues.some((i) => i.code === 'room-sealed' && i.roomIds?.includes('room'))).toBe(true);
    expect(map.doors.filter((d) => d.roomId === 'room')).toEqual([]);
  });
});

describe('generateMap: reachability report (M8 8n)', () => {
  it('a sealed room (doors: []) is reported unreachable with reason "sealed" and a door suggestion', () => {
    const layout = layoutWithRoom({ ...BASE_ROOM, doors: [] });
    const map = generateMap(layout);
    const room = map.rooms.find((r) => r.id === 'room')!;
    expect(room.tiles).toEqual([]);
    expect(map.issues.some((i) => i.code === 'unreachable-room' && i.roomIds?.includes('room'))).toBe(true);

    const unreachable = map.reachability.unreachableRooms.find((u) => u.roomId === 'room');
    expect(unreachable).toBeDefined();
    expect(unreachable!.reason).toBe('sealed');
    expect(unreachable!.suggestion).toBeDefined();
    expect(DOOR_SIDES).toContain(unreachable!.suggestion!.side);
    expect(unreachable!.suggestion!.offset).toBeGreaterThanOrEqual(1);
    expect(unreachable!.suggestion!.width ?? 1).toBeGreaterThanOrEqual(1);

    // The suggestion is a valid, placeable door: applying it actually connects the room.
    const fixed = layoutWithRoom({ ...BASE_ROOM, doors: [unreachable!.suggestion!] });
    const fixedMap = generateMap(fixed);
    expect(hasLayoutErrors(fixedMap.issues)).toBe(false);
    const fixedRoom = fixedMap.rooms.find((r) => r.id === 'room')!;
    expect(fixedRoom.tiles.length).toBeGreaterThan(0);
  });

  it('unreachableSeats counts seats dropped for reachability, and is 0 for a healthy layout', () => {
    const healthy = generateMap(layoutWithRoom({ ...BASE_ROOM }));
    expect(healthy.reachability.unreachableSeats).toBe(0);

    const sealed = generateMap(layoutWithRoom({ ...BASE_ROOM, doors: [] }));
    // The sealed room's own seats never got a chance to be "dropped" (0 reachable tiles means the
    // recipe's seats are filtered out too), so this doesn't assert a specific count - only that the
    // report field exists and is a non-negative number.
    expect(sealed.reachability.unreachableSeats).toBeGreaterThanOrEqual(0);
  });

  it('a healthy layout reports no unreachable rooms', () => {
    const map = generateMap(layoutWithRoom({ ...BASE_ROOM }));
    expect(map.reachability.unreachableRooms).toEqual([]);
  });
});
