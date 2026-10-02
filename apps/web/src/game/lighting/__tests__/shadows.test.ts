import { describe, expect, it } from 'vitest';
import { buildOccluders } from '../occluders';
import { characterShadow, buildLightIndex, furnitureShadows, wallShadows } from '../shadows';
import { sunShadowVector } from '../sun';
import type { CastShadow } from '../types';
import { EVENING, MORNING, NIGHT, NOON, T, furn, light, mapFrom, walledRows } from './lightingFixtures';

const room = () => mapFrom(walledRows(12, 8), { furniture: [furn('bookcase', 4, 3, 2, 1)] });
const out = (): CastShadow => ({ dx: 9, dy: 9, len: 9, alpha: 9 });

describe('furnitureShadows', () => {
  it('cast quads start on the footprint south edge and follow the day vector', () => {
    const m = room();
    const [q] = furnitureShadows(m, MORNING, [], 'cast', 0.25);
    const v = sunShadowVector(MORNING, 14, T);
    expect(q!.points[0]).toEqual({ x: 4 * T, y: 4 * T });
    expect(q!.points[1]).toEqual({ x: 6 * T, y: 4 * T });
    expect(q!.points[2].x - q!.points[1].x).toBeCloseTo(v.x, 6);
    expect(q!.points[2].y - q!.points[1].y).toBeCloseTo(v.y, 6);
  });

  it('the day shadow leans opposite to the sun: skew flips the x direction', () => {
    const dx = (sun: typeof NOON) => {
      const [q] = furnitureShadows(room(), sun, [], 'cast', 0.25);
      return q!.points[2].x - q!.points[1].x;
    };
    expect(dx(MORNING)).toBeGreaterThan(0);
    expect(dx(EVENING)).toBeLessThan(0);
    expect(dx(NOON)).toBeCloseTo(0, 6);
  });

  it('at night the vector points away from the nearest point or ambient-fill light, height * 0.6 long', () => {
    const m = room();
    const lamp = light({ x: 2 * T, y: 3.5 * T, kind: 'ambient-fill', reach: 8 * T, strength: 0.8 });
    const [q] = furnitureShadows(m, NIGHT, [lamp], 'cast', 0.25);
    const vx = q!.points[2].x - q!.points[1].x;
    const vy = q!.points[2].y - q!.points[1].y;
    expect(vx).toBeGreaterThan(0); // lamp is west of the bookcase: shadow goes east
    expect(Math.hypot(vx, vy)).toBeCloseTo(14 * 0.6, 4);
    // a wall light is not a shadow caster in this model; with no usable light the item falls back to the blob
    const [b] = furnitureShadows(m, NIGHT, [light({ kind: 'wall', x: 2 * T, y: 3.5 * T })], 'cast', 0.25);
    expect(b!.points[0].x).toBe(b!.points[3].x);
  });

  it('a north-pointing night vector extrudes from the north edge', () => {
    const lamp = light({ x: 5 * T, y: 6.5 * T, kind: 'point', reach: 8 * T });
    const [q] = furnitureShadows(room(), NIGHT, [lamp], 'cast', 0.25);
    expect(q!.points[0].y).toBe(3 * T);
    expect(q!.points[2].y).toBeLessThan(3 * T);
  });

  it('blob is an unskewed 1 px inset strip at 0.6 of the alpha', () => {
    const [b] = furnitureShadows(room(), MORNING, [], 'blob', 0.25);
    const [c] = furnitureShadows(room(), MORNING, [], 'cast', 0.25);
    expect(b!.points[0].x).toBe(b!.points[3].x);
    expect(b!.points[1].x).toBe(b!.points[2].x);
    expect(b!.points[0].x).toBe(4 * T + 1);
    expect(b!.alpha).toBeCloseTo(c!.alpha * 0.6, 8);
  });

  it('alpha stays within [0, shadowAlpha] and scales with daylight/strength', () => {
    const lamp = light({ x: 2 * T, y: 3.5 * T, reach: 8 * T, strength: 1 });
    for (const [sun, lights] of [[NOON, []], [NIGHT, [lamp]], [MORNING, []]] as const) {
      for (const q of furnitureShadows(room(), sun, lights, 'cast', 0.25)) {
        expect(q.alpha).toBeGreaterThanOrEqual(0);
        expect(q.alpha).toBeLessThanOrEqual(0.25);
      }
    }
    expect(furnitureShadows(room(), NOON, [], 'cast', 0)).toEqual([]);
  });

  it('flat kinds, unknown kinds and prototype names cast nothing', () => {
    const m = mapFrom(walledRows(8, 6), { furniture: [furn('rug', 2, 2), furn('chair', 3, 2), furn('__proto__', 4, 2), furn('constructor', 5, 2), furn('mystery', 6, 2)] });
    expect(furnitureShadows(m, NOON, [], 'cast', 0.25)).toEqual([]);
  });

  it('a shadow never climbs a wall: a desk against the south wall is shortened or dropped', () => {
    const m = mapFrom(walledRows(8, 4), { furniture: [furn('bookcase', 3, 4, 2, 1)] }); // bottom interior row is y = 4
    const quads = furnitureShadows(m, { ...MORNING, elevation: 0.1 }, [], 'cast', 0.25);
    for (const q of quads) for (const p of q.points) expect(p.y).toBeLessThanOrEqual(5 * T);
  });
});

describe('characterShadow / buildLightIndex', () => {
  const m = room();
  const lights = [light({ x: 3 * T, y: 3 * T, reach: 4 * T, strength: 0.5 }), light({ x: 8 * T, y: 3 * T, reach: 4 * T, strength: 0.9 })];
  const idx = buildLightIndex(lights, m.cols, m.rows, T);

  it('writes into the same out object and is zero in blob mode', () => {
    const o = out();
    expect(characterShadow({ x: 5 * T, y: 5 * T }, NIGHT, idx, 'blob', o)).toBe(o);
    expect(o).toEqual({ dx: 0, dy: 0, len: 0, alpha: 0 });
    expect(characterShadow({ x: 5 * T, y: 5 * T }, NIGHT, idx, 'cast', o)).toBe(o);
  });

  it('by day the shadow follows the sun, len within 6..14', () => {
    const o = characterShadow({ x: 5 * T, y: 5 * T }, MORNING, idx, 'cast', out());
    expect(o.dx).toBeGreaterThan(0);
    expect(o.dy).toBeGreaterThan(0);
    expect(Math.hypot(o.dx, o.dy)).toBeCloseTo(1, 6);
    expect(o.len).toBeGreaterThanOrEqual(6);
    expect(o.len).toBeLessThanOrEqual(14);
    expect(o.alpha).toBeGreaterThan(0);
  });

  it('at night the direction is away from the strongest covering light and alpha fades with distance', () => {
    const near = characterShadow({ x: 7 * T, y: 3 * T }, NIGHT, idx, 'cast', out());
    expect(near.dx).toBeLessThan(0); // light at 8 T is east of the feet
    const far = characterShadow({ x: 11 * T, y: 3 * T }, NIGHT, idx, 'cast', out());
    expect(far.dx).toBeGreaterThan(0);
    expect(far.alpha).toBeLessThan(near.alpha);
    expect(near.len).toBeGreaterThanOrEqual(6);
    expect(near.len).toBeLessThanOrEqual(14);
  });

  it('no light in reach (or off-map feet) hides the shadow', () => {
    expect(characterShadow({ x: 6 * T, y: 11 * T }, NIGHT, idx, 'cast', out()).alpha).toBe(0);
    expect(characterShadow({ x: -50, y: 1e9 }, NIGHT, idx, 'cast', out()).alpha).toBe(0);
  });

  it('buildLightIndex returns the nearest/strongest covering light and skips unusable lights', () => {
    const bad = buildLightIndex([light({ reach: NaN }), light({ x: Infinity })], m.cols, m.rows, T);
    expect(bad.items).toHaveLength(0);
    const o = characterShadow({ x: 3.5 * T, y: 3 * T }, NIGHT, idx, 'cast', out());
    expect(o.dx).toBeGreaterThan(0); // nearest is the first light (west of the feet)
  });
});

describe('wallShadows', () => {
  const m = () => mapFrom(walledRows(10, 6));
  const run = (sun: typeof NOON, map = m(), a = 0.25) => wallShadows(map, buildOccluders(map), sun, a);
  const tileOf = (map: ReturnType<typeof m>, p: { x: number; y: number }) => map.tiles[Math.floor(p.y / T)]?.[Math.floor(p.x / T)];

  it('nothing at night or with zero alpha', () => {
    expect(run(NIGHT)).toEqual([]);
    expect(run(NOON, m(), 0)).toEqual([]);
  });

  it('quads start on a wall/floor boundary, lie on floor, and follow sunShadowVector(…, 16)', () => {
    const map = m();
    const qs = run(MORNING, map);
    expect(qs.length).toBeGreaterThan(0);
    const v = sunShadowVector(MORNING, 16, T);
    for (const q of qs) {
      const [a, b, c, d] = q.points;
      // The near edge sits on the boundary between a wall tile and a floor tile.
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const horizontal = a.y === b.y;
      const side = horizontal ? [{ x: mid.x, y: mid.y - 1 }, { x: mid.x, y: mid.y + 1 }] : [{ x: mid.x - 1, y: mid.y }, { x: mid.x + 1, y: mid.y }];
      expect(side.map((p) => tileOf(map, p)).sort()).toEqual(['floor', 'wall']);
      // Shortened at most to a quarter of the vector; same direction.
      const ex = c.x - b.x;
      const ey = c.y - b.y;
      expect(ex * v.y).toBeCloseTo(ey * v.x, 5);
      expect(ey).toBeLessThanOrEqual(v.y + 1e-6);
      expect(ey).toBeGreaterThan(0);
      const fm = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
      const inset = (p: { x: number; y: number }) => ({ x: p.x + Math.sign(fm.x - p.x) * 0.5, y: p.y + Math.sign(fm.y - p.y) * 0.5 });
      for (const p of [inset(c), inset(d), fm]) expect(tileOf(map, p)).toBe('floor');
      expect(q.alpha).toBeCloseTo(0.25 * 0.8 * MORNING.daylight, 6);
    }
  });

  it('the north wall always casts; the side wall depends on the skew sign', () => {
    const north = (qs: ReturnType<typeof run>) => qs.filter((q) => q.points[0].y === q.points[1].y).length;
    const east = (qs: ReturnType<typeof run>, dir: 1 | -1) => qs.filter((q) => q.points[0].x === q.points[1].x && Math.sign(q.points[2].x - q.points[1].x) === dir).length;
    expect(north(run(NOON))).toBe(1);
    expect(east(run(MORNING), 1)).toBe(1);
    expect(east(run(MORNING), -1)).toBe(0);
    expect(east(run(EVENING), -1)).toBe(1);
    expect(east(run(NOON), 1) + east(run(NOON), -1)).toBe(0);
  });

  it('a wall with a wall behind its shadow is shortened or dropped, never climbs a wall', () => {
    const map = mapFrom(walledRows(4, 1));
    for (const q of run(NOON, map)) {
      const [, , c, d] = q.points;
      expect(tileOf(map, { x: (c.x + d.x) / 2, y: c.y - 0.5 })).toBe('floor');
    }
  });

  it('a 1-tile stub still casts a shortened shadow when the sun skew is at least a tile', () => {
    const map = mapFrom(['#######', '#.....#', '#..#..#', '#.....#', '#.....#', '#######']);
    const low = { ...EVENING, elevation: 0.1, skew: 0.9 };
    const v = sunShadowVector(low, 16, T);
    expect(Math.abs(v.x)).toBeGreaterThanOrEqual(T);
    const stub = run(low, map).filter((q) => q.points[0].y === q.points[1].y && q.points[0].y === 3 * T && q.points[0].x >= 3 * T - 0.01);
    expect(stub).toHaveLength(1);
    expect(stub[0]!.points[1].x - stub[0]!.points[0].x).toBeGreaterThan(1);
  });

  it('furnitureShadows is unchanged by the wall pass', () => {
    const map = room();
    expect(furnitureShadows(map, MORNING, [], 'cast', 0.25)).toHaveLength(1);
  });
});
