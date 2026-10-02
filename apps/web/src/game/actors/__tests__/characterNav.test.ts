import { describe, expect, it } from 'vitest';
import { FEET_DY } from '../../nav/constants';
import { navPointOfTile } from '../../nav/grid';
import type { NavPath } from '../../nav/navigator';
import type { Point } from '../../procgen/types';
import { facingOf, feetOfNavPoint, feetOfTile, WalkQueue } from '../walkQueue';

// Character.ts itself needs a Phaser scene; its walk methods are thin wrappers over WalkQueue
// (`walk` = `walkPoints(path.slice(1).map(navPointOfTile))`, `walkNav` = `setNav`), so the pure
// helper is what gets tested here (navigation.md section 4.6).

/** A NavPath that hands out `segments` one call at a time and counts the calls. */
function fakePath(segments: Point[]): NavPath & { calls: number } {
  let cursor = 0;
  const path = {
    cls: 'person' as const,
    from: { x: 0, y: 0 },
    to: segments[segments.length - 1] ?? { x: 0, y: 0 },
    tiles: [],
    repairs: 0,
    pulled: true,
    calls: 0,
    get done() {
      return cursor >= segments.length;
    },
    nextSegment() {
      path.calls++;
      if (cursor >= segments.length) return null;
      return segments[cursor++]!;
    },
    toPoints: () => segments.slice(cursor),
  };
  return path;
}

describe('feet and nav points', () => {
  it('a tile path converts to today\'s feet px exactly: (tx * 16 + 8, ty * 16 + 14)', () => {
    const tiles = [
      { x: 0, y: 0 },
      { x: 3, y: 2 },
      { x: 4, y: 3 },
    ];
    for (const t of tiles) {
      expect(feetOfTile(t)).toEqual({ x: t.x * 16 + 8, y: t.y * 16 + 14 });
      expect(feetOfNavPoint(navPointOfTile(t))).toEqual(feetOfTile(t));
    }
    // `walk(path)`: drop the tile we stand on, the rest become feet points.
    const q = new WalkQueue();
    q.setFeet(tiles.slice(1).map((t) => feetOfNavPoint(navPointOfTile(t))));
    expect(q.peek()).toEqual({ x: 56, y: 46 });
    q.shift();
    expect(q.peek()).toEqual({ x: 72, y: 62 });
    q.shift();
    expect(q.peek()).toBeNull();
    expect(q.walking).toBe(false);
  });

  it('a nav point is the feet shifted up by FEET_DY (a person\'s nav point is the tile centre)', () => {
    expect(FEET_DY).toBe(6);
    expect(feetOfNavPoint({ x: 24, y: 24 })).toEqual({ x: 24, y: 30 });
    expect(navPointOfTile({ x: 1, y: 1 })).toEqual({ x: 24, y: 24 });
  });
});

describe('facingOf', () => {
  it('takes the dominant axis, horizontal on a tie, and keeps the current facing for a zero step', () => {
    expect(facingOf(5, 1, 's')).toBe('e');
    expect(facingOf(-5, 1, 's')).toBe('w');
    expect(facingOf(1, 5, 'e')).toBe('s');
    expect(facingOf(1, -5, 'e')).toBe('n');
    expect(facingOf(3, 3, 'n')).toBe('e');
    expect(facingOf(-3, -3, 'n')).toBe('w');
    expect(facingOf(0, 0, 'n')).toBe('n');
  });
});

describe('WalkQueue with a NavPath', () => {
  it('pulls segments lazily: one per empty queue, never ahead of the walk', () => {
    const path = fakePath([
      { x: 10, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 40 },
    ]);
    const q = new WalkQueue();
    q.setNav(path);
    expect(path.calls).toBe(0);
    expect(q.walking).toBe(true);
    expect(q.peek()).toEqual({ x: 10, y: 10 + FEET_DY });
    expect(path.calls).toBe(1);
    expect(q.peek(), 'peek again does not pull').toEqual({ x: 10, y: 10 + FEET_DY });
    expect(path.calls).toBe(1);
    q.shift();
    expect(q.walking, 'queue empty but the path has more').toBe(true);
    expect(q.peek()).toEqual({ x: 30, y: 10 + FEET_DY });
    q.shift();
    expect(q.peek()).toEqual({ x: 30, y: 40 + FEET_DY });
    expect(path.done).toBe(true);
    expect(q.walking, 'the last point is still queued').toBe(true);
    q.shift();
    expect(q.peek()).toBeNull();
    expect(q.walking).toBe(false);
    expect(path.calls).toBe(3);
  });

  it('an already-done path gives nothing (the walk arrives at once)', () => {
    const q = new WalkQueue();
    q.setNav(fakePath([]));
    expect(q.walking).toBe(false);
    expect(q.peek()).toBeNull();
    expect(q.walking).toBe(false);
  });

  it('a later setFeet, setNav or clear drops the pending path', () => {
    const first = fakePath([{ x: 10, y: 10 }, { x: 20, y: 20 }]);
    const q = new WalkQueue();
    q.setNav(first);
    q.peek();
    q.setFeet([{ x: 99, y: 99 }]);
    expect(q.peek()).toEqual({ x: 99, y: 99 });
    q.shift();
    expect(q.peek()).toBeNull();
    expect(first.calls).toBe(1);
    const second = fakePath([{ x: 1, y: 1 }]);
    q.setNav(second);
    q.clear();
    expect(q.walking).toBe(false);
    expect(q.peek()).toBeNull();
    expect(second.calls).toBe(0);
  });
});

describe('Character integration (the update loop as Character.update runs it)', () => {
  /** The px integration of `Character.update` over a WalkQueue; `onArrive` once when nothing is left. */
  function stepCharacter(pos: Point, q: WalkQueue, step: number, onArrive: () => void): void {
    let next = q.peek();
    while (step > 0 && next !== null) {
      const dx = next.x - pos.x;
      const dy = next.y - pos.y;
      const d = Math.hypot(dx, dy);
      if (d <= step) {
        pos.x = next.x;
        pos.y = next.y;
        q.shift();
        step -= d;
        next = q.peek();
        if (next === null) {
          onArrive();
          next = q.peek(); // a walk started inside onArrive keeps the rest of the step
        }
      } else {
        pos.x += (dx / d) * step;
        pos.y += (dy / d) * step;
        step = 0;
      }
    }
  }

  it('walks a NavPath to its last point, lands exactly on the target feet px, and arrives once', () => {
    const target = navPointOfTile({ x: 5, y: 2 });
    const path = fakePath([navPointOfTile({ x: 2, y: 2 }), target]);
    const q = new WalkQueue();
    q.setNav(path);
    const pos = { ...feetOfTile({ x: 0, y: 2 }) };
    let arrived = 0;
    for (let i = 0; i < 100 && q.walking; i++) stepCharacter(pos, q, 7, () => arrived++);
    expect(pos).toEqual(feetOfTile({ x: 5, y: 2 }));
    expect(arrived).toBe(1);
    expect(q.walking).toBe(false);
    // `Character.tile` of the landing point is the target tile.
    expect({ x: Math.floor(pos.x / 16), y: Math.floor((pos.y - 1) / 16) }).toEqual({ x: 5, y: 2 });
  });

  it('a walk started inside onArrive uses the rest of the same frame\'s step', () => {
    const q = new WalkQueue();
    q.setFeet([{ x: 10, y: 0 }]);
    const pos = { x: 0, y: 0 };
    let arrived = 0;
    stepCharacter(pos, q, 14, () => {
      arrived++;
      q.setFeet([{ x: 100, y: 0 }]);
    });
    expect(arrived).toBe(1);
    expect(pos).toEqual({ x: 14, y: 0 });
    expect(q.walking).toBe(true);
  });
});
