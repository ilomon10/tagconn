import { describe, expect, it } from 'vitest';
import { gatherSpots } from './dramaSpots';

// 7x5 grid, room 'r' covers x 1..5, y 1..3; the cooler is at (3,1) 1x1 against the north wall.
function grid() {
  const walkable = Array.from({ length: 5 }, (_, y) => Array.from({ length: 7 }, (_, x) => (x >= 1 && x <= 5 && y >= 1 && y <= 3 ? 0 : 1)));
  const roomAt = Array.from({ length: 5 }, (_, y) => Array.from({ length: 7 }, (_, x): string | null => (x >= 1 && x <= 5 && y >= 1 && y <= 3 ? 'r' : null)));
  walkable[1]![3] = 1; // the prop itself blocks
  return { walkable, roomAt };
}
const prop = { x: 3, y: 1, w: 1, h: 1, roomId: 'r' };
const free = () => true;

describe('gatherSpots', () => {
  it('returns walkable tiles 4-adjacent to the footprint, nearest first, deterministic', () => {
    const m = grid();
    const a = gatherSpots(m, prop, 1, free);
    expect(a).toEqual([{ x: 2, y: 1 }]); // three tiles tie at distance 1: lowest (y, x)
    expect(gatherSpots(m, prop, 1, free)).toEqual(a);
    const two = gatherSpots(m, prop, 2, free);
    expect(two).toHaveLength(2);
    for (const p of two) expect(Math.abs(p.x - 3) + Math.abs(p.y - 1)).toBe(1);
  });

  it('pairs prefer an opposite side, then an adjacent one', () => {
    const m = grid();
    m.walkable[2]![3] = 1; // prop is now 1x2 conceptually; use h=2 below
    const tall = { x: 3, y: 1, w: 1, h: 2, roomId: 'r' };
    const two = gatherSpots(m, tall, 2, free);
    // west and east neighbours are at the same distance: first is (2,1) by (y,x); second must be the opposite side (4,*)
    expect(two[0]).toEqual({ x: 2, y: 1 });
    expect(two[1]!.x).toBe(4);
  });

  it('skips tiles that are not free', () => {
    const m = grid();
    expect(gatherSpots(m, prop, 1, (p) => !(p.x === 2 && p.y === 1))[0]).not.toEqual({ x: 2, y: 1 });
    expect(gatherSpots(m, prop, 2, () => false)).toEqual([]);
  });

  it('stays inside the prop room and off blocked tiles', () => {
    const m = grid();
    m.roomAt[2]![3] = 'other';
    m.roomAt[1]![2] = null;
    m.walkable[1]![4] = 1;
    expect(gatherSpots(m, prop, 2, free)).toEqual([]);
  });

  it('returns one spot for a pair when only one exists', () => {
    const m = grid();
    const only = (p: { x: number; y: number }) => p.x === 2 && p.y === 1;
    expect(gatherSpots(m, prop, 2, only)).toEqual([{ x: 2, y: 1 }]);
  });
});
