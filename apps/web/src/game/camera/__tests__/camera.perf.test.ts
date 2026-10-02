import { describe, expect, it } from 'vitest';
import { followStep } from '../follow';
import { ZERO_INSETS } from '../insets';
import { snapZoom } from '../snap';

describe('camera perf', () => {
  it('followStep + snapZoom <= 0.1 ms', () => {
    const run = () => {
      const t0 = performance.now();
      followStep({ target: { x: 900, y: 700 }, scrollX: 100, scrollY: 100, camWidth: 800, camHeight: 600, zoom: 2, insets: ZERO_INSETS, worldW: 2000, worldH: 1500, deadzone: 0.3, lagMs: 180, dtMs: 16, instant: false });
      snapZoom(2.4, true, 'round');
      return performance.now() - t0;
    };
    for (let i = 0; i < 50; i++) run();
    const xs = Array.from({ length: 9 }, run).sort((a, b) => a - b);
    expect(xs[4]!).toBeLessThanOrEqual(0.1);
  });
});
