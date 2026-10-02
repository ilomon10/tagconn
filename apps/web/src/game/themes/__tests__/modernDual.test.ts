// M15 D1: the modern dual painters (docs/design/dual-grid.md section 3 modern column, section 4.4). The shared
// harness covers bounds, uniform cells, face/band/door pixels and `paintWallBase` rand parity; the cases below
// pin the modern look: the 1 px cap outline, r=2 rounded outer and inner corners, the floor shadow (2 px to the
// north, band rule), the 2 px ledge / 1 px rim cliffs and the rounded peninsulas, plus the same bounds
// invariants over representative floor kinds.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as Phaser from 'phaser';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../procgen/rng';
import { allCornerCombos, cellFrom, withDoor, type CellOpts } from '../dual/__tests__/fixtures';
import { BIT, cellOrigin, faceMask, isUniform, QUADRANTS, quadrantRect, type DualCell, type FloorKind, type Quadrant } from '../dual/dualGrid';
import { cornerCut } from '../dual/dualGeom';
import { modernTheme } from '../modern';
import {
  CAP_OUTLINE,
  CLIFF,
  MODERN_FLOOR_ACCENT,
  MODERN_FLOOR_BASE,
  paintModernDualFloor,
  paintModernDualWall,
  paintModernWallBase,
} from '../paint/dual/modernDual';
import { lighten } from '../paint/util';
import { paintModernWall } from '../paint/walls';
import { runDualPainterSuite } from '../paint/dual/__tests__/dualHarness';
import { makeBoundsGraphics, type RecordedRect } from './testUtils';
import type { DualCtx } from '../types';

const T = 16;
const WALL_TOP = 0xe8e2d0;
const WALL_EDGE = 0xc9c2ac;
const VOID_ODD = 0x2b2724;
const VOID_EVEN = lighten(VOID_ODD, 0.03);
const SHADOW = 0x000000;

interface Fill {
  c: number;
  a: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Like `makeBoundsGraphics` but keeps the `fillStyle` colour and alpha of each `fillRect`. */
function makeColourGraphics(): { g: Phaser.GameObjects.Graphics; fills: Fill[] } {
  const fills: Fill[] = [];
  let c = 0;
  let a = 1;
  const g: Record<string, (...args: unknown[]) => unknown> = {
    fillStyle: (cc: unknown, aa: unknown = 1) => ((c = cc as number), (a = aa as number), g),
    fillRect: (x: unknown, y: unknown, w: unknown, h: unknown) => (fills.push({ c, a, x: x as number, y: y as number, w: w as number, h: h as number }), g),
  };
  return { g: g as unknown as Phaser.GameObjects.Graphics, fills };
}

type Hook = typeof paintModernDualFloor;

function ctxFor(cell: DualCell, facePass: boolean): DualCtx {
  const { px, py } = cellOrigin(cell, T);
  return { cell, px, py, T, capPx: 3, bandPx: 8, facePass };
}

function paint(hook: Hook, cell: DualCell, facePass = true, rand: () => number = mulberry32(7)): Fill[] {
  const { g, fills } = makeColourGraphics();
  hook(g, ctxFor(cell, facePass), rand);
  return fills;
}

const px = (c: number, x: number, y: number, w: number, h: number, a = 1): Fill => ({ c, a, x, y, w, h });
const outline = (x: number, y: number, w: number, h: number): Fill => px(CAP_OUTLINE, x, y, w, h);
const shadow = (x: number, y: number, w: number, h: number): Fill => px(SHADOW, x, y, w, h, 0.16);
const rim = (x: number, y: number, w: number, h: number): Fill => px(CLIFF, x, y, w, h, 0.6);
const ledge = (x: number, y: number, w: number, h: number): Fill => px(CLIFF, x, y, w, h);

// Default fixture cell (cx = cy = 1): origin (8, 8), centre (16, 16), half = 8. Its quadrant tiles are
// tl (0,0) even, tr (1,0) odd, bl (0,1) odd, br (1,1) even (the `(tx + ty) % 2` checker parity).
const CX = 16;
const CY = 16;

runDualPainterSuite(modernTheme, 'modern');

describe('modern dual painters', () => {
  it('wires the three hooks into the modern theme', () => {
    expect(modernTheme.paintWallBase).toBe(paintModernWallBase);
    expect(modernTheme.paintDualFloor).toBe(paintModernDualFloor);
    expect(modernTheme.paintDualWall).toBe(paintModernDualWall);
  });

  it('keeps the floor colour tables equal to the modern palette', () => {
    expect(MODERN_FLOOR_BASE).toEqual(modernTheme.palette.floorBase);
    expect(MODERN_FLOOR_ACCENT).toEqual(modernTheme.palette.floorAccent);
  });

  it('never derives a tile from pixels (no tileOf)', () => {
    const src = readFileSync(fileURLToPath(new URL('../paint/dual/modernDual.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('tileOf(');
  });

  it('uses no rand() draws in either hook on any corner combo', () => {
    for (const { cell } of allCornerCombos()) {
      for (const facePass of [true, false]) {
        let n = 0;
        const rand = (): number => (n++, 0.5);
        paint(paintModernDualFloor, cell, facePass, rand);
        paint(paintModernDualWall, cell, facePass, rand);
        expect(n).toBe(0);
      }
    }
  });

  describe('paintWallBase', () => {
    it('is paintModernWall(faceVisible=false) without the edge line and draws no rand()', () => {
      const wall = makeColourGraphics();
      paintModernWall(wall.g, 32, 48, false, mulberry32(1));
      expect(wall.fills).toEqual([px(WALL_TOP, 32, 48, T, T), px(WALL_EDGE, 32, 48, T, 1, 0.6)]);
      const base = makeColourGraphics();
      let draws = 0;
      paintModernWallBase(base.g, 32, 48, () => (draws++, 0.5));
      expect(base.fills).toEqual([px(WALL_TOP, 32, 48, T, T)]);
      expect(draws).toBe(0);
    });

    it('stays inside its tile', () => {
      for (const [x, y] of [
        [0, 0],
        [T, 3 * T],
        [7 * T, 5 * T],
      ] as const) {
        const { g, rects } = makeBoundsGraphics();
        paintModernWallBase(g, x, y, mulberry32(1));
        expect(rects.length).toBeGreaterThan(0);
        for (const r of rects) {
          expect(r.x >= x && r.y >= y && r.x + r.w <= x + T && r.y + r.h <= y + T, JSON.stringify(r)).toBe(true);
        }
      }
    });
  });

  describe('cap outline', () => {
    it('runs along the south edge of a wall above void', () => {
      // Half-edges come in `n, e, s, w` order: the east half (towards tr) before the west half (towards tl).
      expect(paint(paintModernDualWall, cellFrom('##  '))).toEqual([outline(CX, CY - 1, 8, 1), outline(8, CY - 1, 8, 1)]);
    });

    it('runs along the north edge of a wall below floor', () => {
      expect(paint(paintModernDualWall, cellFrom('..##'))).toEqual([outline(CX, CY, 8, 1), outline(8, CY, 8, 1)]);
    });

    it('runs along the east edge of a vertical wall beside floor', () => {
      expect(paint(paintModernDualWall, cellFrom('#.#.'))).toEqual([outline(CX - 1, 8, 1, 8), outline(CX - 1, CY, 1, 8)]);
      expect(paint(paintModernDualWall, cellFrom('.#.#'))).toEqual([outline(CX, 8, 1, 8), outline(CX, CY, 1, 8)]);
    });

    it('skips face quadrants entirely', () => {
      expect(paint(paintModernDualWall, cellFrom('##..'))).toEqual([]);
      expect(paint(paintModernDualWall, cellFrom('# . '))).toEqual([]);
      // Only `tr` is a face: its half-edge is skipped and the one boundary left is tl's south edge over void bl.
      expect(paint(paintModernDualWall, cellFrom('## .'))).toEqual([outline(8, CY - 1, 8, 1)]);
    });

    it('outlines all four half-edges of a diagonal without a corner cut', () => {
      const fills = paint(paintModernDualWall, cellFrom('#  #'));
      expect(fills).toHaveLength(4);
      expect(fills.every((f) => f.c === CAP_OUTLINE && (f.w === 8 || f.h === 8))).toBe(true);
    });
  });

  describe('outer corners', () => {
    it('rounds a wall corner against floor: trimmed strips, r=2 cut in the floor colour, outline stepped in', () => {
      const cell = cellFrom('#  .');
      const fills = paint(paintModernDualWall, cell);
      const corridor = MODERN_FLOOR_BASE.corridor;
      expect(fills).toEqual([
        outline(CX - 1, 8, 1, 6),
        outline(8, CY - 1, 6, 1),
        px(corridor, CX - 2, CY - 1, 2, 1),
        px(corridor, CX - 1, CY - 2, 1, 1),
        outline(CX - 2, CY - 2, 1, 1),
      ]);
      // The cut covers exactly `cornerCut(.., 2)`'s pixel set.
      const cutPixels = new Set<string>();
      for (const f of fills.filter((x) => x.c === corridor)) for (let i = 0; i < f.w; i++) cutPixels.add(`${f.x + i},${f.y}`);
      expect(cutPixels).toEqual(new Set(cornerCut(cell, 'tl', 2, T).map((r) => `${r.x},${r.y}`)));
    });

    it('takes the checker accent on an even tile and the base on an odd one', () => {
      // br is tile (1,1): even → accent.
      expect(paint(paintModernDualWall, cellFrom('#  .', { floorKind: 'desks' }))).toContainEqual(px(MODERN_FLOOR_ACCENT.desks, CX - 2, CY - 1, 2, 1));
      // With cx = 2, br is tile (2,1): odd → base.
      const odd = paint(paintModernDualWall, cellFrom('#  .', { floorKind: 'desks', cx: 2 }));
      expect(odd).toContainEqual(px(MODERN_FLOOR_BASE.desks, CX + T - 2, CY - 1, 2, 1));
      // Non-checker kinds always show the base.
      expect(paint(paintModernDualWall, cellFrom('#  .', { floorKind: 'hall' }))).toContainEqual(px(MODERN_FLOOR_BASE.hall, CX - 2, CY - 1, 2, 1));
    });

    it('mirrors the cut into a bottom-right wall quadrant', () => {
      // Wall br, floor tl (tile (0,0), even → desks accent).
      expect(paint(paintModernDualWall, cellFrom('.  #', { floorKind: 'desks' }))).toEqual([
        outline(CX + 2, CY, 6, 1),
        outline(CX, CY + 2, 1, 6),
        px(MODERN_FLOOR_ACCENT.desks, CX, CY, 2, 1),
        px(MODERN_FLOOR_ACCENT.desks, CX, CY + 1, 1, 1),
        outline(CX + 1, CY + 1, 1, 1),
      ]);
    });

    it('cuts in the void checker colour when the diagonal is void', () => {
      // Wall bl, void tr (tile (1,0), odd), floor br: the cut opens onto the void.
      const fills = paint(paintModernDualWall, cellFrom('  #.'));
      expect(fills).toContainEqual(px(VOID_ODD, CX - 2, CY, 2, 1));
      // Wall br, void tl (tile (0,0), even).
      expect(paint(paintModernDualWall, cellFrom('  .#'))).toContainEqual(px(VOID_EVEN, CX, CY, 2, 1));
    });

    it('does nothing on a face quadrant and leaves the cut to the floor pass on a peninsula', () => {
      expect(paint(paintModernDualWall, cellFrom('# . '))).toEqual([]);
      expect(paint(paintModernDualWall, cellFrom('#   '))).toEqual([outline(CX - 1, 8, 1, 6), outline(8, CY - 1, 6, 1), outline(CX - 2, CY - 2, 1, 1)]);
    });
  });

  describe('door beside a convex corner', () => {
    it('keeps the corner square: full-length outlines, no cut, no stepped pixel', () => {
      for (const door of ['tl', 'tr', 'bl'] as const) {
        const fills = paint(paintModernDualWall, withDoor(cellFrom('...#'), door));
        expect(fills.length, door).toBeGreaterThan(0);
        // Strips run the full half-edge (8 px) and nothing is cut or stepped.
        expect(fills.every((f) => f.c === CAP_OUTLINE && (f.w === 8 || f.h === 8)), door).toBe(true);
      }
    });
  });

  describe('inner corners', () => {
    it('rounds a void notch: trimmed strips, wall top on the centre pixel, outline closing the diagonal', () => {
      expect(paint(paintModernDualWall, cellFrom('### '))).toEqual([
        outline(CX + 2, CY - 1, 6, 1),
        outline(CX - 1, CY + 2, 1, 6),
        px(WALL_TOP, CX, CY, 1, 1),
        outline(CX + 1, CY, 1, 1),
        outline(CX, CY + 1, 1, 1),
      ]);
    });

    it('rounds a floor notch beside the walls (tl)', () => {
      expect(paint(paintModernDualWall, cellFrom('.###'))).toEqual([
        outline(CX, 8, 1, 6),
        outline(8, CY, 6, 1),
        px(WALL_TOP, CX - 1, CY - 1, 1, 1),
        outline(CX - 2, CY - 1, 1, 1),
        outline(CX - 1, CY - 2, 1, 1),
      ]);
    });

    it('keeps a floor notch under a face and a door notch square', () => {
      // Floor br under wall tr: tr is a face, only bl's east edge is outlined, full length.
      expect(paint(paintModernDualWall, cellFrom('###.'))).toEqual([outline(CX - 1, CY, 1, 8)]);
      expect(paint(paintModernDualWall, withDoor(cellFrom('.###'), 'tl'))).toEqual([outline(CX, 8, 1, 8), outline(8, CY, 8, 1)]);
    });
  });

  describe('floor shadow', () => {
    it('is 1 px beside a vertical wall', () => {
      expect(paint(paintModernDualFloor, cellFrom('#.#.'))).toEqual([shadow(CX, 8, 1, 8), shadow(CX, CY, 1, 8)]);
      expect(paint(paintModernDualFloor, cellFrom('.#.#'))).toEqual([shadow(CX - 1, 8, 1, 8), shadow(CX - 1, CY, 1, 8)]);
    });

    it('is 2 px under a wall to the north only when the band does not cover it', () => {
      const cell = cellFrom('##..');
      expect(paint(paintModernDualFloor, cell, true)).toEqual([]);
      expect(paint(paintModernDualFloor, cell, false)).toEqual([shadow(CX, CY, 8, 2), shadow(8, CY, 8, 2)]);
    });

    it('is 1 px above a wall to the south', () => {
      expect(paint(paintModernDualFloor, cellFrom('..##'))).toEqual([shadow(CX, CY - 1, 8, 1), shadow(8, CY - 1, 8, 1)]);
    });

    it('skips door quadrants', () => {
      expect(paint(paintModernDualFloor, withDoor(cellFrom('#.#.'), 'tr'))).toEqual([shadow(CX, CY, 1, 8)]);
    });
  });

  describe('cliffs', () => {
    it('lays a 2 px ledge where the void is south of floor or wall', () => {
      expect(paint(paintModernDualFloor, cellFrom('..  '))).toEqual([ledge(CX, CY, 8, 2), ledge(8, CY, 8, 2)]);
      expect(paint(paintModernDualFloor, cellFrom('##  '))).toEqual([ledge(CX, CY, 8, 2), ledge(8, CY, 8, 2)]);
    });

    it('lays a 1 px translucent rim on the other void edges', () => {
      expect(paint(paintModernDualFloor, cellFrom('  ..'))).toEqual([rim(CX, CY - 1, 8, 1), rim(8, CY - 1, 8, 1)]);
      expect(paint(paintModernDualFloor, cellFrom('. . '))).toEqual([rim(CX, 8, 1, 8), rim(CX, CY, 1, 8)]);
    });

    it('draws rims before ledges so the ledge wins where they meet at a void notch', () => {
      // Floor tl, tr, bl; void br: the e half-edge (towards br) is a ledge, the s half-edge a rim.
      expect(paint(paintModernDualFloor, cellFrom('... '))).toEqual([rim(CX, CY, 1, 8), ledge(CX, CY, 8, 2)]);
    });

    it('rounds a floor peninsula with the void to the south: the ledge climbs the corner as a stair', () => {
      expect(paint(paintModernDualFloor, cellFrom('.   '))).toEqual([
        rim(CX, 8, 1, 8),
        ledge(8, CY, 6, 2),
        ledge(CX - 2, CY - 1, 1, 2),
        ledge(CX - 1, CY - 2, 1, 2),
        rim(CX - 1, CY, 1, 1),
        rim(CX - 2, CY + 1, 1, 1),
      ]);
      // A wall peninsula gets the same ledge stair (the wall pass skips its cut there).
      expect(paint(paintModernDualFloor, cellFrom('#   '))).toEqual(paint(paintModernDualFloor, cellFrom('.   ')));
      // Mirrored for tr.
      expect(paint(paintModernDualFloor, cellFrom(' .  '))).toEqual([
        rim(CX - 1, 8, 1, 8),
        ledge(CX + 2, CY, 6, 2),
        ledge(CX + 1, CY - 1, 1, 2),
        ledge(CX, CY - 2, 1, 2),
        rim(CX, CY, 1, 1),
        rim(CX + 1, CY + 1, 1, 1),
      ]);
    });

    it('rounds a floor peninsula with the void to the north: a void-coloured cut and stepped rims', () => {
      // Floor bl; the cut takes the colour of the diagonal void quadrant tr (tile (1,0), odd).
      expect(paint(paintModernDualFloor, cellFrom('  . '))).toEqual([
        px(VOID_ODD, CX - 2, CY, 2, 1),
        px(VOID_ODD, CX - 1, CY + 1, 1, 1),
        rim(CX, CY + 2, 1, 6),
        rim(8, CY - 1, 6, 1),
        rim(CX - 2, CY, 1, 1),
        rim(CX - 1, CY + 1, 1, 1),
      ]);
      // Floor br: diagonal tl is tile (0,0), even.
      expect(paint(paintModernDualFloor, cellFrom('   .'))).toContainEqual(px(VOID_EVEN, CX, CY, 2, 1));
    });

    it('keeps a door peninsula square, with the rim running on beside the ledge', () => {
      expect(paint(paintModernDualFloor, withDoor(cellFrom('.   '), 'tl'))).toEqual([rim(CX, 8, 1, 8), ledge(8, CY, 8, 2), rim(CX, CY, 1, 2)]);
    });
  });

  describe('bounds over representative floor kinds', () => {
    const KINDS: FloorKind[] = ['hall', 'desks', 'qa-lab', 'server-room'];
    const intersects = (a: RecordedRect, b: RecordedRect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

    function forbidden(cell: DualCell, facePass: boolean): RecordedRect[] {
      const out: RecordedRect[] = [];
      const faces = faceMask(cell);
      for (const q of QUADRANTS) {
        if (faces & BIT[q]) {
          out.push(quadrantRect(cell, q, T));
          if (facePass) {
            const below: Quadrant = q === 'tl' ? 'bl' : 'br';
            out.push({ ...quadrantRect(cell, below, T), h: 8 });
          }
        }
        if (cell.doorMask & BIT[q]) out.push(quadrantRect(cell, q, T));
      }
      return out;
    }

    for (const kind of KINDS) {
      it(`${kind}: every rect inside the cell, none on face, band or door quadrants, none on uniform cells`, () => {
        const opts: CellOpts = { floorKind: kind, cx: 3, cy: 2 };
        for (const { spec, cell } of allCornerCombos(opts)) {
          const variants = [cell, ...QUADRANTS.filter((q) => cell.floorMask & BIT[q]).map((q) => withDoor(cell, q))];
          for (const c of variants) {
            for (const facePass of [true, false]) {
              for (const hook of [paintModernDualFloor, paintModernDualWall]) {
                const { g, rects } = makeBoundsGraphics();
                hook(g, ctxFor(c, facePass), mulberry32(3));
                const { px: ox, py: oy } = cellOrigin(c, T);
                if (isUniform(c)) {
                  expect(rects, `${spec}: uniform`).toHaveLength(0);
                  continue;
                }
                for (const r of rects) {
                  expect(r.w > 0 && r.h > 0, `${spec}: empty ${JSON.stringify(r)}`).toBe(true);
                  expect(r.x >= ox && r.y >= oy && r.x + r.w <= ox + T && r.y + r.h <= oy + T, `${spec}: outside ${JSON.stringify(r)}`).toBe(true);
                  for (const f of forbidden(c, facePass)) expect(intersects(r, f), `${spec}: ${JSON.stringify(r)} on ${JSON.stringify(f)}`).toBe(false);
                }
              }
            }
          }
        }
      });
    }
  });
});
