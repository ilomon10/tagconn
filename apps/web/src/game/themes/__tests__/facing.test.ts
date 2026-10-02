import { describe, expect, it } from 'vitest';
import type { PlacedFurniture } from '../../procgen/types';
import { paintForFacing, paintMirroredNS, paintRotated, rotateRectForFacing } from '../paint/facing';
import { modernTheme } from '../modern';
import { makeCommandGraphics } from './testUtils';

const base: PlacedFurniture = { x: 2, y: 5, w: 2, h: 1, kind: 'bench', blocking: true, roomId: 'r1', roomType: 'desks', variant: 1 };
const names = (c: [string, ...unknown[]][]) => c.map((x) => x[0]);

describe('facing helpers (M16 F3)', () => {
  it('rotateRectForFacing turns a south-frame rect about the footprint centre', () => {
    const fp = { x: 32, y: 80, w: 16, h: 32 }; // an e/w footprint: 1 wide, 2 tall
    // the canonical 2x1 art is 32x16 centred on the same point; a rect on its left end lands on the top (w) or bottom (e)
    const left = { x: 24, y: 88, w: 4, h: 16 };
    expect(rotateRectForFacing(left, fp, 's')).toEqual(left);
    const e = rotateRectForFacing(left, fp, 'e');
    const w = rotateRectForFacing(left, fp, 'w');
    expect(e).toEqual({ x: 32, y: 108, w: 16, h: 4 }); // west end of the south frame is the south end facing east
    expect(w).toEqual({ x: 32, y: 80, w: 16, h: 4 });
    expect(rotateRectForFacing(left, { x: 32, y: 80, w: 32, h: 16 }, 'n')).toEqual({ x: 68, y: 72, w: 4, h: 16 });
  });

  it('paintRotated draws as-is for s and brackets the south art in a rotation otherwise', () => {
    const draw = (g: ReturnType<typeof makeCommandGraphics>['g']) => g.fillRect(0, 0, 1, 1);
    const s = makeCommandGraphics();
    paintRotated(s.g, base, 16, draw);
    expect(names(s.commands)).toEqual(['fillRect']);
    const e = makeCommandGraphics();
    paintRotated(e.g, { ...base, w: 1, h: 2, facing: 'e' }, 16, (g, f) => {
      expect([f.w, f.h, f.facing, f.x, f.y]).toEqual([2, 1, undefined, 1.5, 5.5]);
      draw(g);
    });
    expect(names(e.commands)).toEqual(['save', 'translateCanvas', 'rotateCanvas', 'translateCanvas', 'fillRect', 'restore']);
  });

  it('paintMirroredNS flips only for n; paintForFacing leaves fixed kinds alone', () => {
    const n = makeCommandGraphics();
    paintMirroredNS(n.g, { ...base, facing: 'n' }, 16, (g) => g.fillRect(0, 0, 1, 1));
    expect(names(n.commands)).toContain('scaleCanvas');
    const fixed = makeCommandGraphics();
    paintForFacing(fixed.g, { ...base, kind: 'work-desk', facing: 'e' }, 16, (g) => g.fillRect(0, 0, 1, 1));
    expect(names(fixed.commands)).toEqual(['fillRect']);
    const t = makeCommandGraphics();
    modernTheme.paintFurniture(t.g, { ...base, w: 1, h: 2, facing: 'w' }, 16);
    expect(names(t.commands)[0]).toBe('save');
  });
});
