import { describe, expect, it } from 'vitest';
import type { Door, GeneratedMap } from '../../game/procgen';
import { autoDoorsForRoom } from './reachability';

const door = (over: Partial<Door> = {}): Door => ({
  x: 0,
  y: 0,
  roomId: 'r',
  to: 'hall',
  vertical: false,
  side: 'n',
  offset: 1,
  width: 1,
  auto: true,
  ...over,
});

/** Minimal `GeneratedMap` stub — `autoDoorsForRoom` only reads `.doors`. */
const mapWithDoors = (doors: Door[]): GeneratedMap => ({ doors }) as unknown as GeneratedMap;

describe('autoDoorsForRoom', () => {
  it('converts this room\'s auto doors into DoorSpecs (side/offset/width, dropping the tile position)', () => {
    const map = mapWithDoors([door({ roomId: 'r', side: 'n', offset: 2, width: 1 })]);
    expect(autoDoorsForRoom(map, { id: 'r' })).toEqual([{ side: 'n', offset: 2, width: 1 }]);
  });

  it('ignores doors belonging to other rooms', () => {
    const map = mapWithDoors([door({ roomId: 'other', side: 'n', offset: 2 })]);
    expect(autoDoorsForRoom(map, { id: 'r' })).toEqual([]);
  });

  it('ignores a door the layout placed explicitly (auto: false) — it is already in room.doors', () => {
    const map = mapWithDoors([door({ roomId: 'r', auto: false })]);
    expect(autoDoorsForRoom(map, { id: 'r' })).toEqual([]);
  });

  it('dedupes identical (side, offset, width) rows — defensive against one Door per wall tile', () => {
    const map = mapWithDoors([
      door({ roomId: 'r', side: 'n', offset: 2, width: 2, x: 4, y: 2 }),
      door({ roomId: 'r', side: 'n', offset: 2, width: 2, x: 5, y: 2 }), // same opening, second tile
    ]);
    expect(autoDoorsForRoom(map, { id: 'r' })).toEqual([{ side: 'n', offset: 2, width: 2 }]);
  });

  it('preserves multiple doors and a resolved width > 1', () => {
    const map = mapWithDoors([
      door({ roomId: 'r', side: 'n', offset: 2, width: 2 }),
      door({ roomId: 'r', side: 'e', offset: 1, width: 1 }),
    ]);
    expect(autoDoorsForRoom(map, { id: 'r' })).toEqual([
      { side: 'n', offset: 2, width: 2 },
      { side: 'e', offset: 1, width: 1 },
    ]);
  });
});
