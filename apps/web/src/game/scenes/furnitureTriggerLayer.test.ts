import { describe, expect, it } from 'vitest';
import { ringDepthOf } from './ringDepth';

describe('ringDepthOf', () => {
  it('is the footprint south edge in px + 0.5, so a sprite at baseY - 0.5 never covers the ring', () => {
    const f = { y: 3, h: 2 };
    expect(ringDepthOf(f, 16)).toBe(5 * 16 + 0.5);
    expect(ringDepthOf(f, 16)).toBeGreaterThan(5 * 16 - 0.5);
  });
});
