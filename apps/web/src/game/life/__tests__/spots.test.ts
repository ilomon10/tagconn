import { describe, expect, it } from 'vitest';
import type { PlacedFurniture } from '../../procgen/types';
import { nearbySpot, nearWaiting, propSpots, ringSpots, sitTiles } from '../spots';

// 9x7 grid, room 'r' covers x 1..7, y 1..5. Walls elsewhere.
function grid() {
  const inR = (x: number, y: number) => x >= 1 && x <= 7 && y >= 1 && y <= 5;
  const walkable = Array.from({ length: 7 }, (_, y) => Array.from({ length: 9 }, (_, x) => (inR(x, y) ? 0 : 1)));
  const roomAt = Array.from({ length: 7 }, (_, y) => Array.from({ length: 9 }, (_, x): string | null => (inR(x, y) ? 'r' : null)));
  return { walkable, roomAt };
}
const free = () => true;
const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;
const table = { x: 3, y: 2, w: 2, h: 2, roomId: 'r' };

describe('ringSpots', () => {
  it('is deterministic, same room, free and 4-adjacent, clockwise from the north-west', () => {
    const m = grid();
    for (let y = 2; y < 4; y++) for (let x = 3; x < 5; x++) m.walkable[y]![x] = 1;
    const a = ringSpots(m, table, 8, free);
    expect(a).toEqual(ringSpots(m, table, 8, free));
    expect(a).toHaveLength(8);
    expect(a.slice(0, 3)).toEqual([{ x: 3, y: 1 }, { x: 4, y: 1 }, { x: 5, y: 2 }]);
    for (const p of a) {
      expect(m.roomAt[p.y]![p.x]).toBe('r');
      const dx = p.x < 3 ? 3 - p.x : p.x > 4 ? p.x - 4 : 0;
      const dy = p.y < 2 ? 2 - p.y : p.y > 3 ? p.y - 3 : 0;
      expect(dx + dy).toBe(1);
    }
  });
  it('skips non-free tiles, other rooms and respects count', () => {
    const m = grid();
    const north = { x: 3, y: 1, w: 1, h: 1, roomId: 'r' };
    m.walkable[1]![3] = 1;
    const got = ringSpots(m, north, 5, (p) => key(p) !== '4,1');
    expect(got.map(key)).toEqual(['3,2', '2,1']);
    expect(ringSpots(m, north, 1, free)).toHaveLength(1);
  });
});

describe('propSpots', () => {
  it('blocking prop uses the ring only', () => {
    const m = grid();
    const f = { ...table, kind: 'table', blocking: true, roomType: 'meeting-room', variant: 0 } as PlacedFurniture;
    expect(propSpots(m, f, 2, free)).toEqual(ringSpots(m, f, 2, free));
  });
  it('non-blocking prop uses its own tiles first, then the ring', () => {
    const m = grid();
    const sofa = { x: 3, y: 2, w: 2, h: 1, roomId: 'r', kind: 'sofa', blocking: false, roomType: 'lounge', variant: 0 } as PlacedFurniture;
    const got = propSpots(m, sofa, 3, free);
    expect(got.slice(0, 2)).toEqual([{ x: 3, y: 2 }, { x: 4, y: 2 }]);
    expect(got).toHaveLength(3);
    expect(new Set(got.map(key)).size).toBe(3);
  });
});

describe('nearbySpot', () => {
  it('stays within radius and the room', () => {
    const m = grid();
    for (let i = 0; i < 30; i++) {
      const p = nearbySpot(m, { x: 1, y: 1 }, 2, Math.random, free)!;
      expect(Math.abs(p.x - 1) + Math.abs(p.y - 1)).toBeLessThanOrEqual(2);
      expect(m.roomAt[p.y]![p.x]).toBe('r');
      expect(key(p)).not.toBe('1,1');
    }
  });
  it('null when nothing is free or from is in a hall', () => {
    const m = grid();
    expect(nearbySpot(m, { x: 3, y: 3 }, 2, () => 0, () => false)).toBeNull();
    expect(nearbySpot(m, { x: 0, y: 0 }, 2, () => 0, free)).toBeNull();
  });
});

describe('sitTiles / nearWaiting', () => {
  it('collects sit seats only', () => {
    const rooms = [{ seats: [{ x: 1, y: 2, kind: 'sit' }, { x: 3, y: 4, kind: 'stand' }] }] as never;
    expect([...sitTiles({ rooms })]).toEqual(['1,2']);
  });
  it('uses Chebyshev clearance, default 2', () => {
    expect(nearWaiting({ x: 5, y: 5 }, [{ x: 7, y: 3 }])).toBe(true);
    expect(nearWaiting({ x: 5, y: 5 }, [{ x: 8, y: 5 }])).toBe(false);
    expect(nearWaiting({ x: 5, y: 5 }, [{ x: 8, y: 5 }], 3)).toBe(true);
    expect(nearWaiting({ x: 5, y: 5 }, [])).toBe(false);
  });
});
