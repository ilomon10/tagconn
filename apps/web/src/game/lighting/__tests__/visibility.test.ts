import { describe, expect, it } from 'vitest';
import { buildOccluders, nudgeIntoFloor, segmentsForLight } from '../occluders';
import { BASE_RAYS, MAX_RAYS_PER_LIGHT, clipToRadius, containsPoint, visibilityPolygon } from '../visibility';
import { T, mapFrom, walledRows } from './lightingFixtures';
import type { Segment } from '../types';

const angleOf = (o: { x: number; y: number }, p: { x: number; y: number }): number => (Math.atan2(p.y - o.y, p.x - o.x) + 2 * Math.PI) % (2 * Math.PI);

describe('visibilityPolygon', () => {
  it('a light in a closed room never leaves the room interior (+1 px)', () => {
    const o = buildOccluders(mapFrom(walledRows(6, 5)));
    const origin = { x: 4 * T, y: 3.5 * T };
    const poly = visibilityPolygon(origin, segmentsForLight(o, origin, 8 * T), 8 * T);
    expect(poly.length).toBeGreaterThanOrEqual(BASE_RAYS);
    for (const p of poly) {
      expect(p.x).toBeGreaterThanOrEqual(T - 1);
      expect(p.x).toBeLessThanOrEqual(7 * T + 1);
      expect(p.y).toBeGreaterThanOrEqual(T - 1);
      expect(p.y).toBeLessThanOrEqual(6 * T + 1);
    }
  });

  it('with one door the polygon crosses the door tile and nothing else', () => {
    // 5 x 5 room, door in the south wall at x = 3 (the wall row is y = 6); the corridor beyond is open floor.
    const rows = [...walledRows(5, 5, { x: 3, y: 6 }), '.......', '.......'];
    const o = buildOccluders(mapFrom(rows));
    const origin = { x: 3.5 * T, y: 3.5 * T };
    const poly = visibilityPolygon(origin, segmentsForLight(o, origin, 8 * T), 8 * T);
    const beyond = poly.filter((p) => p.y > 7 * T + 1);
    expect(beyond.length).toBeGreaterThan(0);
    for (const p of beyond) {
      // a narrow fan through the door tile (x 3 T..4 T), widening a little with distance
      expect(p.x).toBeGreaterThanOrEqual(2 * T);
      expect(p.x).toBeLessThanOrEqual(5 * T);
    }
    // and nothing leaks through the other walls
    for (const p of poly) {
      if (p.y <= 6 * T + 1) {
        expect(p.x).toBeGreaterThanOrEqual(T - 1);
        expect(p.x).toBeLessThanOrEqual(6 * T + 1);
        expect(p.y).toBeGreaterThanOrEqual(T - 1);
      }
    }
  });

  it('clipToRadius pulls every vertex to at most r along its ray', () => {
    const origin = { x: 50, y: 50 };
    const poly = visibilityPolygon(origin, [], 40);
    const clipped = clipToRadius(origin, poly, 10);
    expect(clipped).toHaveLength(poly.length);
    clipped.forEach((p, i) => {
      expect(Math.hypot(p.x - origin.x, p.y - origin.y)).toBeLessThanOrEqual(10 + 1e-9);
      expect(angleOf(origin, p)).toBeCloseTo(angleOf(origin, poly[i]!), 6);
    });
    // a vertex already inside r is untouched
    expect(clipToRadius(origin, [{ x: 53, y: 50 }], 10)[0]).toEqual({ x: 53, y: 50 });
  });

  it('containsPoint on a square', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(containsPoint(sq, { x: 5, y: 5 })).toBe(true);
    expect(containsPoint(sq, { x: 11, y: 5 })).toBe(false);
    expect(containsPoint(sq, { x: 5, y: -1 })).toBe(false);
  });

  it('is deterministic', () => {
    const o = buildOccluders(mapFrom(walledRows(8, 6)));
    const origin = { x: 5.5 * T, y: 3.2 * T };
    const segs = segmentsForLight(o, origin, 6 * T);
    expect(visibilityPolygon(origin, segs, 6 * T)).toEqual(visibilityPolygon(origin, segs, 6 * T));
  });

  it('a light inside a wall tile is nudged onto its floor side and lights the room', () => {
    const m = mapFrom(walledRows(6, 5));
    const o = buildOccluders(m);
    const raw = { x: 3.5 * T, y: 0.5 * T };
    const origin = nudgeIntoFloor(m.tiles, T, raw);
    expect(origin.y).toBeGreaterThan(T);
    const poly = visibilityPolygon(origin, segmentsForLight(o, origin, 4 * T), 4 * T);
    // most of the disc below the wall is lit
    expect(containsPoint(poly, { x: 3.5 * T, y: 2.5 * T })).toBe(true);
    expect(containsPoint(poly, { x: 3.5 * T, y: 4 * T })).toBe(true);
  });

  it('falls back to the radius circle past MAX_RAYS_PER_LIGHT and returns [] for degenerate input', () => {
    const many: Segment[] = [];
    for (let i = 0; i < 400; i++) many.push({ x1: 100 + i * 0.37, y1: 90, x2: 100 + i * 0.37, y2: 91 + (i % 5) });
    const origin = { x: 100, y: 100 };
    const poly = visibilityPolygon(origin, many, 120);
    expect(poly.length).toBeLessThanOrEqual(MAX_RAYS_PER_LIGHT);
    expect(poly).toHaveLength(BASE_RAYS);
    for (const p of poly) expect(Math.hypot(p.x - 100, p.y - 100)).toBeCloseTo(120, 6);
    expect(visibilityPolygon(origin, many, 0)).toEqual([]);
    expect(visibilityPolygon({ x: NaN, y: 1 }, many, 10)).toEqual([]);
  });

  it('300 random cases: no vertex beyond radius, vertices angle-sorted', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let c = 0; c < 300; c++) {
      const segs: Segment[] = [];
      const n = 1 + Math.floor(rnd() * 12);
      for (let i = 0; i < n; i++) {
        const x = rnd() * 200;
        const y = rnd() * 200;
        segs.push(rnd() < 0.5 ? { x1: x, y1: y, x2: x + rnd() * 80, y2: y } : { x1: x, y1: y, x2: x, y2: y + rnd() * 80 });
      }
      const origin = { x: rnd() * 200, y: rnd() * 200 };
      const radius = 20 + rnd() * 100;
      const poly = visibilityPolygon(origin, segs, radius);
      let prev = -1;
      for (const p of poly) {
        expect(Math.hypot(p.x - origin.x, p.y - origin.y)).toBeLessThanOrEqual(radius + 1e-6);
        const a = angleOf(origin, p);
        expect(a).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = a;
      }
    }
  });
});
