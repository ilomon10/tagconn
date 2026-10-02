import { describe, expect, it } from 'vitest';
import { KIND_HEIGHT, OCCLUDER_MIN_HEIGHT_PX, kindHeight } from '../heights';
import { buildOccluders, nudgeIntoFloor, segmentsForLight, segmentsNear } from '../occluders';
import { T, furn, mapFrom, walledRows } from './lightingFixtures';

describe('buildOccluders', () => {
  it('a walled 5 x 5 room yields exactly 4 boundary runs', () => {
    const o = buildOccluders(mapFrom(walledRows(5, 5)));
    expect(o.segments).toHaveLength(4);
    expect(o.wallCount).toBe(4);
    // e.g. the north run spans the whole interior at the wall's bottom edge
    expect(o.segments).toContainEqual({ x1: T, y1: T, x2: 6 * T, y2: T });
  });

  it('a door tile leaves a gap in its run and adds the wall-to-door sides', () => {
    const o = buildOccluders(mapFrom(walledRows(5, 5, { x: 3, y: 6 })));
    const south = o.segments.filter((s) => s.y1 === 6 * T && s.y2 === 6 * T);
    // the south wall row's top edge (y = 6 T) is a wall/floor boundary except under the door
    expect(south.map((s) => [s.x1 / T, s.x2 / T])).toEqual([
      [1, 3],
      [4, 6],
    ]);
  });

  it('never puts a segment on void: a wall next to void only occludes towards the floor', () => {
    const o = buildOccluders(mapFrom(walledRows(3, 3)));
    for (const s of o.segments) {
      const mx = (s.x1 + s.x2) / 2;
      const my = (s.y1 + s.y2) / 2;
      // sample a hair to each side of the segment midpoint: exactly one side may be wall, the other floor, none void
      const sides = s.y1 === s.y2 ? [[mx, my - 1], [mx, my + 1]] : [[mx - 1, my], [mx + 1, my]];
      const kinds = sides.map(([x, y]) => (o.tiles[Math.floor(y! / T)]?.[Math.floor(x! / T)] ?? 'void'));
      expect(kinds).not.toContain('void');
    }
  });

  it('a bookcase adds 4 segments, a rug none, a half-tile pinned bookcase its real rect', () => {
    const rows = walledRows(8, 6);
    const none = buildOccluders(mapFrom(rows)).segments.length;
    const book = buildOccluders(mapFrom(rows, { furniture: [furn('bookcase', 2, 2, 2, 1)] }));
    expect(book.segments.length).toBe(none + 4);
    expect(buildOccluders(mapFrom(rows, { furniture: [furn('rug', 2, 2, 3, 2), furn('work-desk', 5, 3, 2, 1)] })).segments.length).toBe(none);
    const pin = buildOccluders(mapFrom(rows, { furniture: [{ ...furn('bookcase', 2.5, 2, 1.5, 1), pinned: true }] }));
    expect(pin.segments.slice(pin.wallCount)).toContainEqual({ x1: 2.5 * T, y1: 2 * T, x2: 4 * T, y2: 2 * T });
    expect(pin.segments.slice(pin.wallCount)).toContainEqual({ x1: 4 * T, y1: 2 * T, x2: 4 * T, y2: 3 * T });
  });

  it('segmentsNear is a subset of all and a superset of the brute-force distance query', () => {
    const o = buildOccluders(mapFrom(walledRows(10, 8, { x: 4, y: 9 }), { furniture: [furn('rack', 3, 3), furn('cabinet', 7, 5, 2, 1)] }));
    for (const [px, py, r] of [[5.5 * T, 4.5 * T, 3 * T], [2 * T, 2 * T, 5 * T], [9 * T, 7 * T, 8 * T], [0, 0, 2 * T]] as const) {
      const near = segmentsNear(o, { x: px, y: py }, r);
      for (const s of near) expect(o.segments).toContain(s);
      const brute = o.segments.filter((s) => {
        const dx = Math.max(Math.min(s.x1, s.x2) - px, 0, px - Math.max(s.x1, s.x2));
        const dy = Math.max(Math.min(s.y1, s.y2) - py, 0, py - Math.max(s.y1, s.y2));
        return Math.hypot(dx, dy) <= r;
      });
      expect(near).toHaveLength(brute.length);
      for (const s of brute) expect(near).toContain(s);
    }
  });

  it('segmentsForLight drops the sides of the furniture rect the light sits in', () => {
    const o = buildOccluders(mapFrom(walledRows(6, 5), { furniture: [furn('fireplace', 2, 2, 2, 1)] }));
    const inside = segmentsForLight(o, { x: 3 * T, y: 2.5 * T }, 4 * T);
    const outside = segmentsForLight(o, { x: 5.5 * T, y: 4.5 * T }, 8 * T);
    expect(outside.length).toBe(inside.length + 4);
  });

  it('nudgeIntoFloor moves a wall-tile origin onto its floor side and leaves floor origins alone', () => {
    const m = mapFrom(walledRows(5, 5));
    const wall = nudgeIntoFloor(m.tiles, T, { x: 3.5 * T, y: 0.5 * T });
    expect(wall.y).toBeGreaterThan(T);
    expect(m.tiles[Math.floor(wall.y / T)]![3]).toBe('floor');
    const floor = { x: 3.5 * T, y: 3.5 * T };
    expect(nudgeIntoFloor(m.tiles, T, floor)).toBe(floor);
  });
});

describe('heights', () => {
  it('keeps desks below the occluder threshold and bookcases above', () => {
    expect(KIND_HEIGHT['work-desk']).toBeLessThan(OCCLUDER_MIN_HEIGHT_PX);
    expect(KIND_HEIGHT.bookcase).toBeGreaterThanOrEqual(OCCLUDER_MIN_HEIGHT_PX);
    expect(KIND_HEIGHT['stairs-up']).toBe(0);
  });

  it('kindHeight is own-property guarded: prototype and unknown kinds are height 0 and never occlude', () => {
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nope', '']) expect(kindHeight(k)).toBe(0);
    expect(kindHeight('bookcase')).toBe(KIND_HEIGHT.bookcase);
    const o = buildOccluders(mapFrom(walledRows(6, 5), { furniture: [furn('__proto__', 2, 2), furn('constructor', 3, 2), furn('mystery', 4, 2)] }));
    expect(o.boxes).toHaveLength(0);
    // a poisoned override table is guarded too
    expect(kindHeight('constructor', Object.create({ constructor: 99 }) as Record<string, number>)).toBe(0);
  });
});
