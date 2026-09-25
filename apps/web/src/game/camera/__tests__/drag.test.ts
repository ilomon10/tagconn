import { describe, expect, it } from 'vitest';
import { DRAG_THRESHOLD_PX, isDragMove } from '../drag';

describe('isDragMove', () => {
  it('treats tiny movement as a click, not a drag', () => {
    expect(isDragMove(0, 0)).toBe(false);
    expect(isDragMove(1, 1)).toBe(false);
  });

  it('treats movement at or beyond the threshold as a drag', () => {
    expect(isDragMove(DRAG_THRESHOLD_PX, 0)).toBe(true);
    expect(isDragMove(0, DRAG_THRESHOLD_PX)).toBe(true);
    expect(isDragMove(10, 10)).toBe(true);
  });

  it('measures Euclidean distance, not per-axis', () => {
    // 3-4-5 triangle: neither axis alone reaches a threshold of 4, but the hypotenuse (5) does.
    expect(isDragMove(3, 3.2, 4)).toBe(true);
  });

  it('accepts a custom threshold', () => {
    expect(isDragMove(5, 0, 10)).toBe(false);
    expect(isDragMove(11, 0, 10)).toBe(true);
  });
});
