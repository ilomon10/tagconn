import { describe, expect, it } from 'vitest';
import { snapZoom } from '../snap';

describe('snapZoom', () => {
  it('fit rounds down at or above 1', () => {
    expect(snapZoom(2.9, true, 'fit')).toBe(2);
    expect(snapZoom(1, true, 'fit')).toBe(1);
    expect(snapZoom(1.99999999999, true, 'fit')).toBe(2);
  });
  it('round goes to the nearest stop', () => {
    expect(snapZoom(2.4, true, 'round')).toBe(2);
    expect(snapZoom(2.6, true, 'round')).toBe(3);
  });
  it('stays continuous below 1', () => {
    expect(snapZoom(0.63, true, 'fit')).toBe(0.63);
    expect(snapZoom(0.63, true, 'round')).toBe(0.63);
  });
  it('is the identity (clamped) when off', () => {
    expect(snapZoom(2.37, false, 'fit')).toBe(2.37);
    expect(snapZoom(0.05, false, 'fit')).toBe(0.2);
    expect(snapZoom(99, false, 'round')).toBe(6);
    expect(snapZoom(99, true, 'round')).toBe(6);
  });
  it('never snaps a value in [1, 1.5) below 1', () => {
    expect(snapZoom(1.4, true, 'round')).toBe(1);
  });
});
