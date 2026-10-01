import { describe, expect, it } from 'vitest';
import { irisPolygons, irisFullRadius, swirlWedges, type Polygon } from '../swirl';

function inside(p: { x: number; y: number }, poly: Polygon): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
function coverage(polys: Polygon[], w: number, h: number): number {
  let hit = 0;
  let total = 0;
  for (let x = 0.5; x < w; x += w / 40) {
    for (let y = 0.5; y < h; y += h / 40) {
      total++;
      if (polys.some((pl) => inside({ x, y }, pl))) hit++;
    }
  }
  return hit / total;
}

describe.each([[375, 667], [1920, 1080]])('swirl at %ix%i', (w, h) => {
  it('is empty at 0 and covers 100% at 1', () => {
    expect(swirlWedges(0, w, h)).toEqual([]);
    expect(coverage(swirlWedges(1, w, h), w, h)).toBe(1);
  });
  it('grows monotonically', () => {
    let prev = 0;
    for (const t of [0.2, 0.4, 0.6, 0.8, 1]) {
      const c = coverage(swirlWedges(t, w, h), w, h);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
    expect(coverage(swirlWedges(0.5, w, h), w, h)).toBeLessThan(1);
  });
  it('makes the requested wedge count', () => {
    expect(swirlWedges(0.5, w, h)).toHaveLength(8);
    expect(swirlWedges(0.5, w, h, 5)).toHaveLength(5);
  });
  it('iris: r=0 covers all, full radius covers nothing', () => {
    expect(coverage(irisPolygons(0, w, h), w, h)).toBe(1);
    expect(irisPolygons(irisFullRadius(w, h), w, h)).toEqual([]);
    const mid = coverage(irisPolygons(Math.min(w, h) / 4, w, h), w, h);
    expect(mid).toBeGreaterThan(0.5);
    expect(mid).toBeLessThan(1);
  });
});
