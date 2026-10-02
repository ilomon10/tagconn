import { describe, expect, it } from 'vitest';
import { snapRect } from './snap';

const interior = { x: 0, y: 0, w: 10, h: 8 };
const r = (x: number, y: number, w = 1, h = 1) => ({ x, y, w, h });

describe('snapRect', () => {
  it('snaps an edge to a neighbour edge within the tolerance and reports the guide', () => {
    const out = snapRect(r(4, 3), [r(5.5, 6, 2, 1)], interior);
    expect(out.x).toBe(4.5); // right edge 5 -> neighbour's left edge 5.5
    expect(out.guides).toContainEqual({ axis: 'x', at: 5.5 });
  });
  it('snaps centres and the interior edges', () => {
    // centre of a 1x1 at 2.5 is 3; neighbour 2 wide at x 2 has centre 3
    expect(snapRect(r(2.5, 4), [r(2, 0, 2, 1)], interior).x).toBe(2.5);
    const edge = snapRect(r(0.5, 7), [], interior);
    expect(edge).toMatchObject({ x: 0, y: 7 }); // left edge to the interior's left edge
    expect(edge.guides).toContainEqual({ axis: 'x', at: 0 });
  });
  it('does nothing beyond the tolerance', () => {
    const out = snapRect(r(4, 3), [r(6, 6)], interior);
    expect(out).toMatchObject({ x: 4, y: 3 });
    expect(out.guides).toEqual([]);
  });
  it('picks the nearest candidate and never leaves the half-tile grid', () => {
    // a 1-wide neighbour at 4.5 has centre 5; dragged left edge 4.5 is 0 away from the left edge: stays
    expect(snapRect(r(4.5, 0), [r(4.5, 5)], interior).x).toBe(4.5);
    // a candidate that would need a quarter-tile shift is skipped
    const out = snapRect(r(3, 3), [r(3.25 as number, 6, 1, 1)], interior);
    expect(out.x % 0.5).toBe(0);
  });
});
