// M15 D3 (docs/design/dual-grid.md section 3, rift column; section 4.4): the shared harness over the rift theme
// plus the rift-specific checks: the cliff rim is one pixel into the void so `paintIslandEdge`'s jag stays
// visible, the cap rim replaces the per-tile top line, and corner cuts take the outside colour.
import type * as Phaser from 'phaser';
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../procgen/rng';
import { allCornerCombos, cellFrom, withDoor } from '../dual/__tests__/fixtures';
import { BIT, cellOrigin, QUADRANTS, quadrantRect, type DualCell } from '../dual/dualGrid';
import { runDualPainterSuite } from '../paint/dual/__tests__/dualHarness';
import { paintRiftDualFloor, paintRiftDualWall, paintRiftWallBase, RIFT_CAP_RIM } from '../paint/dual/riftDual';
import { paintRiftIslandEdge, paintRiftWall } from '../paint/riftWalls';
import { riftTheme } from '../rift';
import type { DualCtx } from '../types';
import { makeBoundsGraphics, type RecordedRect } from './testUtils';

runDualPainterSuite(riftTheme, 'rift');

const T = 16;
const OBSIDIAN = 0x161022;
const TEAL = 0x1f5a5a;
const VOID_BASE = 0x0b0820;
const BRIDGE_BASE = 0x1c1a2e;
const CRYSTAL_BASE = 0x2a2350;

interface ColorRect extends RecordedRect {
  color: number;
  alpha: number;
}

/** Like `makeBoundsGraphics`, but keeps the `fillStyle` colour/alpha of every `fillRect`. */
function makeColorGraphics(): { g: Phaser.GameObjects.Graphics; rects: ColorRect[] } {
  const rects: ColorRect[] = [];
  let color = 0;
  let alpha = 1;
  const g: Record<string, (...args: unknown[]) => unknown> = {};
  for (const m of ['fillCircle', 'fillEllipse', 'fillTriangle', 'lineStyle', 'strokeCircle', 'strokeEllipse', 'generateTexture', 'destroy']) {
    g[m] = () => g;
  }
  g.fillStyle = (...args: unknown[]) => {
    color = args[0] as number;
    alpha = (args[1] as number | undefined) ?? 1;
    return g;
  };
  g.fillRect = (...args: unknown[]) => {
    const [x, y, w, h] = args as number[];
    rects.push({ x: x!, y: y!, w: w!, h: h!, color, alpha });
    return g;
  };
  return { g: g as unknown as Phaser.GameObjects.Graphics, rects };
}

function ctxFor(cell: DualCell, facePass: boolean): DualCtx {
  const { px, py } = cellOrigin(cell, T);
  const { capPx, bandPx } = riftTheme.backWall!;
  return { cell, px, py, T, capPx, bandPx, facePass };
}

/** Both hooks on `cell`, in render order (floor then wall), with colours. */
function paintBoth(cell: DualCell, facePass: boolean, seed = 7): ColorRect[] {
  const { g, rects } = makeColorGraphics();
  const ctx = ctxFor(cell, facePass);
  paintRiftDualFloor(g, ctx, mulberry32(seed));
  paintRiftDualWall(g, ctx, mulberry32(seed + 1));
  return rects;
}

function intersects(a: RecordedRect, b: RecordedRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function at(rects: ColorRect[], x: number, y: number): ColorRect[] {
  return rects.filter((r) => intersects(r, { x, y, w: 1, h: 1 }));
}

describe('rift dual painters', () => {
  // The cell centre (tile corner) of the fixtures' default cell (cx = cy = 1).
  const cx = T;
  const cy = T;

  it('paintWallBase draws the obsidian fill and mortar rows but no top line', () => {
    const { g, rects } = makeColorGraphics();
    paintRiftWallBase(g, T, T, mulberry32(3));
    expect(rects[0]).toMatchObject({ x: T, y: T, w: T, h: T, color: OBSIDIAN });
    const mortar = rects.filter((r) => r.color === TEAL && r.w === T && r.h === 1).map((r) => r.y - T);
    expect(mortar).toEqual([4, 8, 12]);
    expect(rects.some((r) => r.y === T && r.h === 1 && r.w === T), 'the per-tile top line must not be drawn').toBe(false);
    // Every colour it uses is one `paintRiftWall` uses too (no new palette).
    const { g: g2, rects: wall } = makeColorGraphics();
    paintRiftWall(g2, T, T, false, mulberry32(3));
    const wallColors = new Set(wall.map((r) => r.color));
    for (const r of rects) expect(wallColors.has(r.color), `colour ${r.color.toString(16)}`).toBe(true);
  });

  it('cliff rim: on every floor/void or wall/void boundary each void-side rect is 1 px into the void, touching the boundary', () => {
    for (const { spec, cell } of allCornerCombos()) {
      for (const facePass of [true, false]) {
        const rects = paintBoth(cell, facePass);
        for (const q of QUADRANTS) {
          if (!(cell.voidMask & BIT[q])) continue;
          const qr = quadrantRect(cell, q, T);
          for (const r of rects) {
            if (!intersects(r, qr)) continue;
            // Every pixel of the rect lies on the one-pixel ring next to the centre cross.
            const onVertical = r.w === 1 && (r.x === cx - 1 || r.x === cx);
            const onHorizontal = r.h === 1 && (r.y === cy - 1 || r.y === cy);
            expect(onVertical || onHorizontal, `${spec} facePass=${facePass} ${q}: ${JSON.stringify(r)} reaches past the rim`).toBe(true);
          }
        }
      }
    }
  });

  it('stacking: a floor-vs-void rim stays in its cell and leaves the island jag below the top row untouched', () => {
    for (const spec of ['..  ', '##  ', '.#  ', 'D.  ']) {
      const cell = cellFrom(spec);
      const { px, py } = cellOrigin(cell, T);
      const rects = paintBoth(cell, true);
      expect(rects.length).toBeGreaterThan(0);
      for (const r of rects) {
        expect(r.x >= px && r.y >= py && r.x + r.w <= px + T && r.y + r.h <= py + T, `${spec}: ${JSON.stringify(r)} leaves the cell`).toBe(true);
      }
      // The two void tiles under the cell: (cx-1, cy) and (cx, cy). The island jag on each starts at the tile's
      // top row (the rim's row) and runs `h` rows down; only its top row may be covered.
      for (const tx of [cell.cx - 1, cell.cx]) {
        for (const depth of [1, 2] as const) {
          const { g, rects: island } = makeBoundsGraphics();
          paintRiftIslandEdge(g, tx * T, cell.cy * T, depth, mulberry32(11 + tx));
          const jag = island.find((r) => r.h === (depth === 1 ? 6 : 3))!;
          expect(jag, `${spec}: island jag at depth ${depth}`).toBeDefined();
          const below = { x: jag.x, y: jag.y + 1, w: jag.w, h: jag.h - 1 };
          for (const r of rects) expect(intersects(r, below), `${spec}: ${JSON.stringify(r)} covers the jag ${JSON.stringify(below)}`).toBe(false);
        }
      }
      // And in the void half every rect is the 1 px rim on the boundary row.
      for (const r of rects.filter((x) => x.y >= cy)) {
        expect(r.y, `${spec}: ${JSON.stringify(r)}`).toBe(cy);
        expect(r.h).toBe(1);
        expect(r.color).toBe(TEAL);
      }
    }
  });

  it('cap rim: a wall quadrant next to floor or void gets the lit obsidian rim on its boundary side, face quadrants none', () => {
    // bl wall under tl floor, tr void, br floor: rim on the `w` (above) and `s` (right) half-edges of bl.
    const rects = paintBoth(cellFrom('. #.'), true);
    const rim = rects.filter((r) => r.color === RIFT_CAP_RIM);
    expect(rim).toContainEqual(expect.objectContaining({ x: cx - T / 2, y: cy, w: T / 2, h: 1 }));
    expect(rim).toContainEqual(expect.objectContaining({ x: cx - 1, y: cy, w: 1, h: T / 2 }));
    // A wall over floor (face quadrant) is never touched, with or without the face pass.
    for (const facePass of [true, false]) {
      const face = paintBoth(cellFrom('##..'), facePass);
      const tl = quadrantRect(cellFrom('##..'), 'tl', T);
      const tr = quadrantRect(cellFrom('##..'), 'tr', T);
      expect(face.some((r) => intersects(r, tl) || intersects(r, tr))).toBe(false);
    }
  });

  it('convex wall corner: r = 2 cut in the outside colour, rim stepped in by one', () => {
    // br wall alone; tl (the diagonal) is corridor floor → bridge base; void diagonal → void base.
    for (const [spec, outside] of [
      ['.  #', BRIDGE_BASE],
      ['   #', VOID_BASE],
    ] as const) {
      const rects = paintBoth(cellFrom(spec), true);
      const cuts: [number, number][] = [
        [cx, cy],
        [cx + 1, cy],
        [cx, cy + 1],
      ];
      for (const [x, y] of cuts) {
        const last = at(rects, x, y).at(-1);
        expect(last?.color, `${spec}: cut pixel (${x - cx}, ${y - cy})`).toBe(outside);
      }
      expect(at(rects, cx + 1, cy + 1).at(-1)?.color, `${spec}: step pixel`).toBe(RIFT_CAP_RIM);
    }
    // A room floor diagonal takes the crystal base.
    const room = paintBoth(cellFrom('.  #', { floorKind: 'desks' }), true);
    expect(at(room, cx, cy).at(-1)?.color).toBe(CRYSTAL_BASE);
  });

  it('concave corner: the notch pixel turns obsidian, except on a door or under a face band', () => {
    const voidNotch = paintBoth(cellFrom('### '), true);
    expect(at(voidNotch, cx, cy).at(-1)?.color).toBe(OBSIDIAN);
    // bl notch under face tl: left to the band when facePass, painted otherwise.
    const under = cellFrom('##.#');
    expect(at(paintBoth(under, true), cx - 1, cy)).toHaveLength(0);
    expect(at(paintBoth(under, false), cx - 1, cy).at(-1)?.color).toBe(OBSIDIAN);
    // tr notch (floor) is not under a face: painted in both passes.
    for (const facePass of [true, false]) expect(at(paintBoth(cellFrom('#.##'), facePass), cx, cy - 1).at(-1)?.color).toBe(OBSIDIAN);
    // A door notch stays square.
    expect(at(paintBoth(withDoor(cellFrom('#.##'), 'tr'), false), cx, cy - 1)).toHaveLength(0);
  });

  it('floor glow: 1 px teal at alpha 0.45 on the floor side of wall/floor boundaries, clipped by the band under a face', () => {
    // Walls on the left, floor on the right: two vertical glow strips just right of the centre line.
    const glow = paintBoth(cellFrom('#.#.'), true).filter((r) => r.color === TEAL && r.alpha === 0.45);
    expect(glow).toHaveLength(2);
    for (const r of glow) expect(r).toMatchObject({ x: cx, w: 1, h: T / 2 });
    // Floor under a wall (face): the horizontal strip lies entirely in the band, so nothing with the face pass.
    expect(paintBoth(cellFrom('##..'), true).filter((r) => r.color === TEAL && r.alpha === 0.45)).toHaveLength(0);
    const flat = paintBoth(cellFrom('##..'), false).filter((r) => r.color === TEAL && r.alpha === 0.45);
    expect(flat).toHaveLength(2);
    for (const r of flat) expect(r).toMatchObject({ y: cy, w: T / 2, h: 1 });
    // A vertical strip under a face starts bandPx lower.
    const { bandPx } = riftTheme.backWall!;
    const clipped = paintBoth(cellFrom('##.#'), true).filter((r) => r.color === TEAL && r.alpha === 0.45);
    expect(clipped).toEqual([expect.objectContaining({ x: cx - 1, y: cy + bandPx, w: 1, h: T / 2 - bandPx })]);
    // No glow against void.
    expect(paintBoth(cellFrom(' . .'), true).filter((r) => r.color === TEAL && r.alpha === 0.45)).toHaveLength(0);
  });

  it('is deterministic per cell and seed', () => {
    const a = paintBoth(cellFrom('#.#.'), true, 5);
    const b = paintBoth(cellFrom('#.#.'), true, 5);
    expect(a).toEqual(b);
  });
});
