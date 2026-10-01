import { describe, expect, it } from 'vitest';
import { pinchDistance, pinchMidpoint } from '../pinch';

describe('pinch helpers', () => {
  it('measures the distance between two fingers', () => {
    expect(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it('finds the midpoint to zoom about', () => {
    expect(pinchMidpoint({ x: 10, y: 20 }, { x: 30, y: 60 })).toEqual({ x: 20, y: 40 });
  });
});
