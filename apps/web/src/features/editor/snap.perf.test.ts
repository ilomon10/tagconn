import { describe, expect, it } from 'vitest';
import { snapRect } from './snap';

const interior = { x: 0, y: 0, w: 10, h: 8 };
const r = (x: number, y: number, w = 1, h = 1) => ({ x, y, w, h });

describe('snapRect perf', () => {
  it('is fast with 48 neighbours', () => {
    const others = Array.from({ length: 48 }, (_, i) => r(i % 9, i % 7));
    const t = performance.now();
    for (let i = 0; i < 100; i++) snapRect(r(4.5, 3.5), others, interior);
    expect((performance.now() - t) / 100).toBeLessThan(0.5); // generous; the design budget is 0.05 ms
  });
});
