import { describe, expect, it } from 'vitest';
import { blockCenterPx, pixelVignetteShade, smoothVignetteShade, vignetteBandPx, vignetteT } from '../vignette';

const W = 1200;
const H = 800;
const band = vignetteBandPx(W, H, 0.12); // 96px

describe('edge vignette', () => {
  it('sizes the frame from the shorter screen side', () => {
    expect(band).toBeCloseTo(96);
    expect(vignetteBandPx(10, 10, 0.01)).toBe(1); // never below 1px
  });

  it('leaves the whole middle clean: t = 0 everywhere inside the inner rectangle', () => {
    for (const [x, y] of [
      [W / 2, H / 2],
      [band + 1, H / 2],
      [W - band - 1, H / 2],
      [W / 2, band + 1],
      [band + 1, band + 1],
    ] as const) {
      expect(vignetteT(x, y, W, H, band)).toBe(0);
    }
  });

  it('rises to 1 at the edge, and corners reach full darkness', () => {
    expect(vignetteT(0, H / 2, W, H, band)).toBeCloseTo(1);
    expect(vignetteT(W / 2, H, W, H, band)).toBeCloseTo(1);
    expect(vignetteT(band / 2, H / 2, W, H, band)).toBeCloseTo(0.5);
    expect(vignetteT(0, 0, W, H, band)).toBe(1);
    // Rounded inner corner: diagonal points are darker than the same inset on a straight edge.
    expect(vignetteT(band / 2, band / 2, W, H, band)).toBeGreaterThan(vignetteT(band / 2, H / 2, W, H, band));
  });

  it('smooth: 0 in the middle, full strength at the edge, monotonic', () => {
    expect(smoothVignetteShade(0, 0.4)).toBe(0);
    expect(smoothVignetteShade(1, 0.4)).toBeCloseTo(0.4);
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const v = smoothVignetteShade(t, 0.4);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('pixel: 4 steps show exactly 25/50/75/100% of strength inside the frame, and 0 in the middle', () => {
    const seen = new Set<number>();
    for (let t = 0; t <= 1.0001; t += 0.01) seen.add(Number(pixelVignetteShade(Math.min(t, 1), 4, 1).toFixed(4)));
    expect([...seen].sort()).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(pixelVignetteShade(0, 4, 0.4)).toBe(0);
    expect(pixelVignetteShade(0.01, 4, 0.4)).toBeCloseTo(0.1);
    expect(pixelVignetteShade(1, 4, 0.4)).toBeCloseTo(0.4);
  });

  it('pixel: the shade is constant across a block, and blocks scale with zoom', () => {
    const a = blockCenterPx(1, 1, 4, 2);
    const b = blockCenterPx(7, 7, 4, 2);
    expect(a).toEqual(b); // same 8px block at zoom 2
    expect(a).toEqual({ x: 4, y: 4 });
    expect(blockCenterPx(9, 0, 4, 2)).toEqual({ x: 12, y: 4 });
  });
});
