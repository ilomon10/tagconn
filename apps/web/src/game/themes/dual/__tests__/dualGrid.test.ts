import { describe, expect, it } from 'vitest';
import { BIT, cellOrigin, cornerKind, QUADRANTS, quadrantRect, quadrantTile } from '../dualGrid';

describe('dualGrid (W0 pure helpers)', () => {
  it('mask bits are tl<<3 | tr<<2 | bl<<1 | br', () => {
    expect(BIT).toEqual({ tl: 8, tr: 4, bl: 2, br: 1 });
    expect(QUADRANTS.reduce((m, q) => m | BIT[q], 0)).toBe(0xf);
  });

  it('quadrantTile samples the four tiles around the corner (cx, cy)', () => {
    const cell = { cx: 3, cy: 5 };
    expect(quadrantTile(cell, 'tl')).toEqual({ x: 2, y: 4 });
    expect(quadrantTile(cell, 'tr')).toEqual({ x: 3, y: 4 });
    expect(quadrantTile(cell, 'bl')).toEqual({ x: 2, y: 5 });
    expect(quadrantTile(cell, 'br')).toEqual({ x: 3, y: 5 });
    // The border cell samples off-map tiles (negative coordinates), which callers treat as void.
    expect(quadrantTile({ cx: 0, cy: 0 }, 'tl')).toEqual({ x: -1, y: -1 });
  });

  it('cellOrigin is half a tile up and left of the corner', () => {
    expect(cellOrigin({ cx: 0, cy: 0 }, 16)).toEqual({ px: -8, py: -8 });
    expect(cellOrigin({ cx: 2, cy: 1 }, 16)).toEqual({ px: 24, py: 8 });
  });

  it('quadrantRect tiles the cell with four T/2 squares', () => {
    const cell = { cx: 2, cy: 1 };
    expect(quadrantRect(cell, 'tl', 16)).toEqual({ x: 24, y: 8, w: 8, h: 8 });
    expect(quadrantRect(cell, 'tr', 16)).toEqual({ x: 32, y: 8, w: 8, h: 8 });
    expect(quadrantRect(cell, 'bl', 16)).toEqual({ x: 24, y: 16, w: 8, h: 8 });
    expect(quadrantRect(cell, 'br', 16)).toEqual({ x: 32, y: 16, w: 8, h: 8 });
  });

  it('cornerKind: off-map and void are void, door is floor', () => {
    expect(cornerKind(undefined)).toBe('void');
    expect(cornerKind('void')).toBe('void');
    expect(cornerKind('wall')).toBe('wall');
    expect(cornerKind('floor')).toBe('floor');
    expect(cornerKind('door')).toBe('floor');
  });
});
