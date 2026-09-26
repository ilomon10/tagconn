import { describe, expect, it } from 'vitest';
import { hitScaleFor } from '../hitsize';

describe('hitScaleFor', () => {
  it('is 1 when the world size already meets the minimum at zoom 1', () => {
    expect(hitScaleFor(24, 1)).toBe(1);
    expect(hitScaleFor(30, 1)).toBe(1);
  });

  it('is 1 when zoomed in enough that the rendered size already exceeds the minimum', () => {
    expect(hitScaleFor(14, 2)).toBe(1); // 14 * 2 = 28 >= 24
  });

  it('grows the scale so worldSizePx * zoom * scale hits the minimum exactly', () => {
    const scale = hitScaleFor(14, 1);
    expect(scale).toBeCloseTo(24 / 14);
    expect(14 * 1 * scale).toBeCloseTo(24);
  });

  it('accounts for zoom below 1 (the common low-zoom case)', () => {
    const zoom = 0.5;
    const scale = hitScaleFor(14, zoom);
    expect(scale).toBeCloseTo(24 / (14 * zoom));
    expect(14 * zoom * scale).toBeCloseTo(24);
  });

  it('never returns less than 1 (never shrinks a hit area)', () => {
    expect(hitScaleFor(100, 5)).toBe(1);
    expect(hitScaleFor(24, 100)).toBe(1);
  });

  it('clamps at 8 for extreme zoom-out instead of growing unbounded', () => {
    const scale = hitScaleFor(14, 0.01);
    expect(scale).toBe(8);
  });

  it('honors a custom minScreenPx', () => {
    const scale = hitScaleFor(10, 1, 40);
    expect(scale).toBeCloseTo(4);
  });

  it('is defensive against non-positive inputs', () => {
    expect(hitScaleFor(0, 1)).toBe(1);
    expect(hitScaleFor(14, 0)).toBe(1);
    expect(hitScaleFor(-5, 1)).toBe(1);
    expect(hitScaleFor(14, -1)).toBe(1);
  });
});
