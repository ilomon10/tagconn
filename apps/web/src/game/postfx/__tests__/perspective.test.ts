import { describe, expect, it } from 'vitest';
import { PERSPECTIVE_HAZE_MAX, PERSPECTIVE_K_MAX, perspectiveSource, perspectiveUniforms, unproject } from '../perspective';

describe('perspectiveUniforms', () => {
  it('is identity at 0', () => {
    const u = perspectiveUniforms(0, 2, 800, 0x123456);
    expect(u.k).toBe(0);
    expect(u.hazeStrength).toBe(0);
  });
  it('scales with the setting and unpacks the bg colour', () => {
    const u = perspectiveUniforms(1, 2, 800, 0xff8000);
    expect(u.k).toBe(PERSPECTIVE_K_MAX);
    expect(u.hazeStrength).toBe(PERSPECTIVE_HAZE_MAX);
    expect(u.haze[0]).toBe(1);
    expect(u.haze[1]).toBeCloseTo(128 / 255);
    expect(u.haze[2]).toBe(0);
    expect(u.texel).toBeCloseTo(2 / 800);
  });
  it('clamps out-of-range and guards a zero viewport', () => {
    expect(perspectiveUniforms(5, 1, 0, 0).k).toBe(PERSPECTIVE_K_MAX);
    expect(perspectiveUniforms(-1, 1, 0, 0).k).toBe(0);
    expect(perspectiveUniforms(0.5, 1, 0, 0).texel).toBe(0);
  });
});

describe('perspectiveUniforms phase', () => {
  it('is the fractional art-row offset of the scroll in UV units, 0 for no scroll or a whole number of rows', () => {
    expect(perspectiveUniforms(0.5, 2, 800, 0).phase).toBe(0);
    expect(perspectiveUniforms(0.5, 2, 800, 10).phase).toBeCloseTo(0);
    expect(perspectiveUniforms(0.5, 2, 800, 10.25).phase).toBeCloseTo(0.5 / 800);
    expect(perspectiveUniforms(0.5, 2, 800, -0.25).phase).toBeCloseTo(1.5 / 800);
    expect(perspectiveUniforms(0.5, 2, 0, 3.3).phase).toBe(0);
    expect(perspectiveUniforms(0, 2, 800, 3.3).k).toBe(0);
  });
});

describe('perspectiveSource / unproject', () => {
  it('keeps the endpoints and is monotonic', () => {
    const k = PERSPECTIVE_K_MAX;
    expect(perspectiveSource(0, k)).toBe(0);
    expect(perspectiveSource(1, k)).toBe(1);
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const s = perspectiveSource(t, k);
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });
  it('unproject is identity at 0 and drifts at most k*H/4', () => {
    expect(unproject(321, 800, 0)).toBe(321);
    const k = 0.03;
    let max = 0;
    for (let y = 0; y <= 800; y += 5) max = Math.max(max, Math.abs(unproject(y, 800, k) - y));
    expect(max).toBeCloseTo((k * 800) / 4, 5);
    expect(max).toBeLessThanOrEqual(6.0001);
  });
});
