import { describe, expect, it } from 'vitest';
import type { PlacedFurniture } from '../../procgen/types';
import { paintForFacing, paintMirroredNS, paintRotated, rotateRectForFacing } from '../paint/facing';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import { riftTheme } from '../rift';
import { makeCommandGraphics, overshootOf } from './testUtils';

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

// M16 F6: explicit facing variants (furnishing.md section 5.3) for chair, armchair, sofa and booth in every style.
describe('explicit facing variants (M16 F6)', () => {
  const themes = { modern: modernTheme, guild: guildTheme, rift: riftTheme } as const;
  const SEATS = ['chair', 'armchair', 'sofa'] as const;
  const sizes = [{ w: 1, h: 1 }, { w: 2, h: 1 }, { w: 3, h: 1 }, { w: 1.5, h: 1 }, { w: 2.5, h: 1 }];
  const item = (kind: PlacedFurniture['kind'], w: number, h: number, facing: PlacedFurniture['facing'], roomType: PlacedFurniture['roomType'] = 'desks'): PlacedFurniture => ({
    x: 2, y: 5, w, h, kind, blocking: true, roomId: 'r1', roomType, variant: 1, facing,
  });

  for (const [name, theme] of Object.entries(themes)) {
    it(`${name}: seats stay inside their rotated footprint in n, e and w`, () => {
      for (const kind of SEATS)
        for (const { w, h } of sizes)
          for (const facing of ['n', 'e', 'w'] as const) {
            const f = item(kind, facing === 'n' ? w : h, facing === 'n' ? h : w, facing, 'library');
            const { g, rects } = makeCommandGraphics();
            theme.paintFurniture(g, f, 16);
            expect(rects.length, `${kind} ${facing}`).toBeGreaterThan(0);
            const o = overshootOf(rects, f, 16);
            expect(o, `${kind} ${w}x${h} ${facing}`).toEqual({ l: 0, t: 0, r: 0, b: 0 });
          }
    });

    it(`${name}: the four views of a seat are distinct, and s is the untouched south art`, () => {
      for (const kind of SEATS) {
        const streams = (['s', 'n', 'e', 'w'] as const).map((facing) => {
          const f = item(kind, facing === 'e' || facing === 'w' ? 1 : 2, facing === 'e' || facing === 'w' ? 2 : 1, facing, 'library');
          const { g, commands } = makeCommandGraphics();
          theme.paintFurniture(g, f, 16);
          return JSON.stringify(commands);
        });
        expect(new Set(streams).size, kind).toBe(4);
        const plain = makeCommandGraphics();
        theme.paintFurniture(plain.g, { ...item(kind, 2, 1, undefined, 'library') }, 16);
        const south = makeCommandGraphics();
        theme.paintFurniture(south.g, item(kind, 2, 1, 's', 'library'), 16);
        expect(JSON.stringify(south.commands)).toBe(JSON.stringify(plain.commands));
      }
    });
  }

  it('modern and guild booths: n is a back panel, e/w rotate the south art within the south overhang', () => {
    for (const theme of [modernTheme, guildTheme]) {
      const south = makeCommandGraphics();
      theme.paintFurniture(south.g, item('booth', 1, 1, 's'), 16);
      const limit = overshootOf(south.rects, item('booth', 1, 1, 's'), 16);
      const north = makeCommandGraphics();
      theme.paintFurniture(north.g, item('booth', 1, 1, 'n'), 16);
      expect(JSON.stringify(north.commands)).not.toBe(JSON.stringify(south.commands));
      for (const [k, v] of Object.entries(overshootOf(north.rects, item('booth', 1, 1, 'n'), 16))) expect(v).toBeLessThanOrEqual(limit[k as 'l'] + (k === 't' ? 2 : 0));
      for (const facing of ['e', 'w'] as const) {
        const { g, commands } = makeCommandGraphics();
        theme.paintFurniture(g, item('booth', 1, 1, facing), 16);
        expect(commands[0]?.[0]).toBe('save');
      }
    }
  });

  it('the guild lounge stool looks the same from every side', () => {
    const draws = (['s', 'n', 'e', 'w'] as const).map((facing) => {
      const { g, commands } = makeCommandGraphics();
      guildTheme.paintFurniture(g, item('armchair', 1, 1, facing, 'lounge'), 16);
      return JSON.stringify(commands);
    });
    expect(new Set(draws).size).toBe(1);
  });
});
