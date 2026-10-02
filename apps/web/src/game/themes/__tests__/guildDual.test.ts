// M15 D2: the guild dual painters (docs/design/dual-grid.md section 3 guild column, section 4.4). The shared
// harness covers bounds, uniform cells, face/band/door pixels and `paintWallBase` rand parity; the cases below
// pin the guild look: lit north/west and dark south/east cap lines, the r=1 chamfer, the floor shadow under the
// band rule, the mortar ledge on cliffs, and the moss speck.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as Phaser from 'phaser';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../procgen/rng';
import { cellFrom, withDoor } from '../dual/__tests__/fixtures';
import { cellOrigin, type DualCell } from '../dual/dualGrid';
import { guildTheme } from '../guild';
import { GUILD_FLOOR_BASE, paintGuildDualFloor, paintGuildDualWall, paintGuildWallBase } from '../paint/dual/guildDual';
import { darken, lighten } from '../paint/util';
import { paintGuildWall } from '../paint/walls';
import { runDualPainterSuite } from '../paint/dual/__tests__/dualHarness';
import type { DualCtx } from '../types';

const T = 16;
const WALL_TOP = 0x5a5068;
const CAP_LIT = lighten(WALL_TOP, 0.3);
const CAP_DARK = darken(WALL_TOP, 0.35);
const LEDGE = darken(WALL_TOP, 0.5);
const LEDGE_LIP = lighten(LEDGE, 0.1);
const MOSS = 0x4d6b3a;
const VOID = 0x0e0b14;
const CORRIDOR_SHADOW = darken(GUILD_FLOOR_BASE.corridor, 0.2);

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

type Hook = typeof paintGuildDualFloor;

function paint(hook: Hook, cell: DualCell, facePass = true, rand: () => number = mulberry32(7)): Fill[] {
  const { g, fills } = makeColourGraphics();
  const { px, py } = cellOrigin(cell, T);
  const ctx: DualCtx = { cell, px, py, T, capPx: 2, bandPx: 10, facePass };
  hook(g, ctx, rand);
  return fills;
}

const strip = (c: number, x: number, y: number, w: number, h: number): Fill => ({ c, a: 1, x, y, w, h });

// Default fixture cell (cx = cy = 1): origin (8, 8), centre (16, 16), half = 8.
const CX = 16;
const CY = 16;

runDualPainterSuite(guildTheme, 'guild');

describe('guild dual painters', () => {
  it('wires the three hooks into the guild theme', () => {
    expect(guildTheme.paintWallBase).toBe(paintGuildWallBase);
    expect(guildTheme.paintDualFloor).toBe(paintGuildDualFloor);
    expect(guildTheme.paintDualWall).toBe(paintGuildDualWall);
  });

  it('keeps GUILD_FLOOR_BASE equal to the guild palette floor bases', () => {
    expect(GUILD_FLOOR_BASE).toEqual(guildTheme.palette.floorBase);
  });

  it('never derives a tile from pixels (no tileOf)', () => {
    const src = readFileSync(fileURLToPath(new URL('../paint/dual/guildDual.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('tileOf(');
  });

  it('paintWallBase is paintGuildWall(faceVisible=false) without the lit top line', () => {
    for (const seed of [1, 2, 3, 11, 42]) {
      const wall = makeColourGraphics();
      paintGuildWall(wall.g, 32, 48, false, mulberry32(seed));
      const base = makeColourGraphics();
      paintGuildWallBase(base.g, 32, 48, mulberry32(seed));
      const litLine = wall.fills.findIndex((f) => f.c === lighten(WALL_TOP, 0.18) && f.y === 48 && f.h === 1 && f.w === T);
      expect(litLine).toBeGreaterThanOrEqual(0);
      const expected = wall.fills.filter((_, i) => i !== litLine);
      expect(base.fills).toEqual(expected);
      expect(base.fills.some((f) => f.c === lighten(WALL_TOP, 0.18))).toBe(false);
    }
  });

  describe('cap outline', () => {
    it('is dark on the south edge of a wall above void, with a mortar ledge below', () => {
      const cell = cellFrom('##  ');
      // Half-edges come in `n, e, s, w` order: the east half (towards tr) before the west half (towards tl).
      expect(paint(paintGuildDualWall, cell)).toEqual([strip(CAP_DARK, CX, CY - 1, 8, 1), strip(CAP_DARK, 8, CY - 1, 8, 1)]);
      expect(paint(paintGuildDualFloor, cell, true, () => 0.99)).toEqual([
        strip(LEDGE, CX, CY, 8, 2),
        strip(LEDGE_LIP, CX, CY, 8, 1),
        strip(LEDGE, 8, CY, 8, 2),
        strip(LEDGE_LIP, 8, CY, 8, 1),
      ]);
    });

    it('is lit on the north edge of a wall below void', () => {
      const cell = cellFrom('  ##');
      expect(paint(paintGuildDualWall, cell)).toEqual([strip(CAP_LIT, CX, CY, 8, 1), strip(CAP_LIT, 8, CY, 8, 1)]);
    });

    it('is dark on the east edge and lit on the west edge of a vertical wall', () => {
      // Wall on the left (tl, bl), floor on the right: the wall's east edge faces the floor.
      expect(paint(paintGuildDualWall, cellFrom('#.#.'))).toEqual([strip(CAP_DARK, CX - 1, 8, 1, 8), strip(CAP_DARK, CX - 1, CY, 1, 8)]);
      // Wall on the right (tr, br): its west edge faces the floor.
      expect(paint(paintGuildDualWall, cellFrom('.#.#'))).toEqual([strip(CAP_LIT, CX, 8, 1, 8), strip(CAP_LIT, CX, CY, 1, 8)]);
    });

    it('skips face quadrants entirely', () => {
      expect(paint(paintGuildDualWall, cellFrom('##..'))).toEqual([]);
      expect(paint(paintGuildDualWall, cellFrom('# . '))).toEqual([]);
      // Only `tr` is a face: tr's half-edge is skipped and the one boundary left is tl's south edge over void bl.
      expect(paint(paintGuildDualWall, cellFrom('## .'))).toEqual([strip(CAP_DARK, 8, CY - 1, 8, 1)]);
    });

    it('outlines all four half-edges of a diagonal without a corner cut', () => {
      const fills = paint(paintGuildDualWall, cellFrom('#  #'));
      expect(fills).toHaveLength(4);
      expect(fills.every((f) => f.w === 8 || f.h === 8)).toBe(true);
      expect(fills.map((f) => f.c).sort()).toEqual([CAP_DARK, CAP_DARK, CAP_LIT, CAP_LIT].sort());
    });
  });

  describe('corners', () => {
    it('chamfers a convex wall corner with one pixel of the diagonal quadrant colour', () => {
      // Wall tl over void everywhere: the corner pixel at (CX-1, CY-1) shows the void.
      const voidCut = paint(paintGuildDualWall, cellFrom('#   '));
      expect(voidCut).toContainEqual(strip(VOID, CX - 1, CY - 1, 1, 1));
      expect(voidCut.filter((f) => f.w === 1 && f.h === 1)).toHaveLength(1);
      // Wall tl, floor br: the chamfer shows the floor base of the diagonal quadrant.
      const floorCut = paint(paintGuildDualWall, cellFrom('#  .'));
      expect(floorCut).toContainEqual(strip(GUILD_FLOOR_BASE.corridor, CX - 1, CY - 1, 1, 1));
      // Wall br, floor tl (room floor kind): the chamfer is in br and takes the desks base.
      const desksCut = paint(paintGuildDualWall, cellFrom('.  #', { floorKind: 'desks' }));
      expect(desksCut).toContainEqual(strip(GUILD_FLOOR_BASE.desks, CX, CY, 1, 1));
    });

    it('leaves concave (inner) corners sharp', () => {
      // Three walls, floor br: tr is a face. Only strips, never a corner pixel.
      const fills = paint(paintGuildDualWall, cellFrom('###.'));
      expect(fills.length).toBeGreaterThan(0);
      expect(fills.every((f) => f.w === 8 || f.h === 8)).toBe(true);
      const voidNotch = paint(paintGuildDualWall, cellFrom('### '));
      expect(voidNotch.every((f) => f.w === 8 || f.h === 8)).toBe(true);
    });
  });

  describe('floor shadow', () => {
    it('darkens the floor side of every wall/floor half-edge', () => {
      expect(paint(paintGuildDualFloor, cellFrom('#.#.'))).toEqual([strip(CORRIDOR_SHADOW, CX, 8, 1, 8), strip(CORRIDOR_SHADOW, CX, CY, 1, 8)]);
      const desks = paint(paintGuildDualFloor, cellFrom('.#.#', { floorKind: 'desks' }));
      expect(desks).toEqual([strip(darken(GUILD_FLOOR_BASE.desks, 0.2), CX - 1, 8, 1, 8), strip(darken(GUILD_FLOOR_BASE.desks, 0.2), CX - 1, CY, 1, 8)]);
    });

    it('is skipped under a face quadrant when facePass (the band covers it) and drawn otherwise', () => {
      const cell = cellFrom('##..');
      expect(paint(paintGuildDualFloor, cell, true)).toEqual([]);
      expect(paint(paintGuildDualFloor, cell, false)).toEqual([strip(CORRIDOR_SHADOW, CX, CY, 8, 1), strip(CORRIDOR_SHADOW, 8, CY, 8, 1)]);
    });

    it('skips door quadrants', () => {
      const cell = withDoor(cellFrom('#.#.'), 'tr');
      expect(paint(paintGuildDualFloor, cell)).toEqual([strip(CORRIDOR_SHADOW, CX, CY, 1, 8)]);
    });

    it('draws nothing on a floor/void boundary (the cliff sits on the void side)', () => {
      const fills = paint(paintGuildDualFloor, cellFrom('.. '.padEnd(4, ' ')), true, () => 0.99);
      expect(fills.every((f) => f.c === LEDGE || f.c === LEDGE_LIP)).toBe(true);
      expect(fills.every((f) => f.y >= CY)).toBe(true);
    });
  });

  describe('cliff', () => {
    it('lays a 2 px mortar ledge with a 1 px lip against the edge on the void side', () => {
      // Floor tl only; void around it: cliffs on n (towards tr) and w (towards bl).
      expect(paint(paintGuildDualFloor, cellFrom('.   '), true, () => 0.99)).toEqual([
        strip(LEDGE, CX, 8, 2, 8),
        strip(LEDGE_LIP, CX, 8, 1, 8),
        strip(LEDGE, 8, CY, 8, 2),
        strip(LEDGE_LIP, 8, CY, 8, 1),
      ]);
    });

    it('adds a moss speck inside the ledge on rand() < 0.1 and none otherwise', () => {
      const cell = cellFrom('##  ');
      const draws: number[] = [0.05, 0.5, 0.5];
      const mossy = paint(paintGuildDualFloor, cell, true, () => draws.shift() ?? 0.99);
      const moss = mossy.filter((f) => f.c === MOSS);
      expect(moss).toHaveLength(1);
      // The speck lands in the first ledge (the east half: x 16..24, y 16..18) at rand() = 0.5 for both axes.
      expect(moss[0]).toEqual({ c: MOSS, a: 0.65, x: CX + 4, y: CY + 1, w: 1, h: 1 });
      expect(paint(paintGuildDualFloor, cell, true, () => 0.99).some((f) => f.c === MOSS)).toBe(false);
      // No cliff, no moss draw at all.
      let n = 0;
      paint(paintGuildDualFloor, cellFrom('#.#.'), true, () => (n++, 0));
      expect(n).toBe(0);
    });
  });
});
