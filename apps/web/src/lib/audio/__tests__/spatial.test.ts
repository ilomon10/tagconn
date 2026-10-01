import { describe, expect, it } from 'vitest';
import { spatialGain, spatialPan } from '../spatial';

const l = { x: 100, y: 100, halfW: 80, halfH: 60 };

describe('spatialGain', () => {
  it('is 1 inside the central half of the view', () => {
    expect(spatialGain({ x: 100, y: 100 }, l)).toBe(1);
    expect(spatialGain({ x: 140, y: 130 }, l)).toBe(1);
  });
  it('falls off linearly and is 0 beyond 1.25 x the half-diagonal', () => {
    const mid = spatialGain({ x: 180, y: 100 }, l);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(spatialGain({ x: 100 + 126, y: 100 }, l)).toBe(0);
    expect(spatialGain({ x: 5000, y: 5000 }, l)).toBe(0);
  });
  it('decreases monotonically with distance', () => {
    expect(spatialGain({ x: 160, y: 100 }, l)).toBeGreaterThan(spatialGain({ x: 200, y: 100 }, l));
  });
  it('handles a degenerate view', () => {
    expect(spatialGain({ x: 5, y: 5 }, { x: 0, y: 0, halfW: 0, halfH: 0 })).toBe(0);
  });
});

describe('spatialPan', () => {
  it('is clamped to +-0.6 and signed by side', () => {
    expect(spatialPan({ x: 100, y: 0 }, l)).toBe(0);
    expect(spatialPan({ x: 180, y: 0 }, l)).toBeCloseTo(0.6);
    expect(spatialPan({ x: 1000, y: 0 }, l)).toBeCloseTo(0.6);
    expect(spatialPan({ x: -1000, y: 0 }, l)).toBeCloseTo(-0.6);
    expect(spatialPan({ x: 140, y: 0 }, l)).toBeCloseTo(0.3);
  });
});
