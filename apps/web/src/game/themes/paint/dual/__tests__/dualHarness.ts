// Shared painter suite for the dual pass (docs/design/dual-grid.md section 4.4). Each style's test calls
// `runDualPainterSuite(theme, name)`; the harness has no `.test.ts` suffix so vitest never collects it alone.
import { describe, expect, it } from 'vitest';
import { makeBoundsGraphics, type RecordedRect } from '../../../__tests__/testUtils';
import { allCornerCombos, withDoor } from '../../../dual/__tests__/fixtures';
import { BIT, cellOrigin, faceMask, isUniform, QUADRANTS, quadrantRect, type DualCell, type Quadrant } from '../../../dual/dualGrid';
import type { DualCtx, ThemeDefinition } from '../../../types';
import { mulberry32 } from '../../../../procgen/rng';

const T = 16;
const SEEDS = 50;

type DualHook = 'paintDualFloor' | 'paintDualWall';
const HOOKS: readonly DualHook[] = ['paintDualFloor', 'paintDualWall'];

function intersects(a: RecordedRect, b: RecordedRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Pixels the dual painters must never touch on `cell`: face quadrants, the band under them (when `facePass`), doors. */
function forbiddenRects(cell: DualCell, facePass: boolean, bandPx: number): { why: string; rect: RecordedRect }[] {
  const out: { why: string; rect: RecordedRect }[] = [];
  const faces = faceMask(cell);
  for (const q of QUADRANTS) {
    if (faces & BIT[q]) {
      out.push({ why: `face quadrant ${q}`, rect: quadrantRect(cell, q, T) });
      if (facePass && bandPx > 0) {
        const below: Quadrant = q === 'tl' ? 'bl' : 'br';
        const r = quadrantRect(cell, below, T);
        out.push({ why: `band under face quadrant ${q}`, rect: { x: r.x, y: r.y, w: r.w, h: Math.min(bandPx, r.h) } });
      }
    }
    if (cell.doorMask & BIT[q]) out.push({ why: `door quadrant ${q}`, rect: quadrantRect(cell, q, T) });
  }
  return out;
}

function paint(theme: ThemeDefinition, hook: DualHook, cell: DualCell, facePass: boolean): RecordedRect[] {
  const { g, rects } = makeBoundsGraphics();
  const { px, py } = cellOrigin(cell, T);
  const { capPx, bandPx } = theme.backWall ?? { capPx: 0, bandPx: 0 };
  const ctx: DualCtx = { cell, px, py, T, capPx, bandPx, facePass };
  theme[hook]?.(g, ctx, mulberry32(cell.wallMask * 31 + cell.floorMask));
  return rects;
}

/** Counts `rand()` draws made by `fn`. */
function countDraws(fn: (rand: () => number) => void, seed: number): number {
  const rand = mulberry32(seed);
  let n = 0;
  fn(() => (n++, rand()));
  return n;
}

/**
 * The invariants every dual painter keeps (dual-grid.md section 0, invariants 1, 3, 4, 6, 8), checked over the 81
 * corner combos (plus one door variant per floor quadrant) x `facePass` x both hooks, and the `paintWallBase`
 * rand parity against `paintWall(faceVisible = false)` over 50 seeds.
 */
export function runDualPainterSuite(theme: ThemeDefinition, name: string): void {
  describe(`${name} dual painters`, () => {
    const bandPx = theme.backWall?.bandPx ?? 0;
    const cases: { label: string; cell: DualCell }[] = [];
    for (const { spec, cell } of allCornerCombos()) {
      cases.push({ label: JSON.stringify(spec), cell });
      for (const q of QUADRANTS) if (cell.floorMask & BIT[q]) cases.push({ label: `${JSON.stringify(spec)} door ${q}`, cell: withDoor(cell, q) });
    }

    it('defines both dual hooks and paintWallBase', () => {
      expect(typeof theme.paintDualFloor).toBe('function');
      expect(typeof theme.paintDualWall).toBe('function');
      expect(typeof theme.paintWallBase).toBe('function');
    });

    for (const hook of HOOKS) {
      for (const facePass of [true, false]) {
        it(`${hook} (facePass=${facePass}) stays inside the cell and off face, band and door pixels`, () => {
          for (const { label, cell } of cases) {
            const rects = paint(theme, hook, cell, facePass);
            const { px, py } = cellOrigin(cell, T);
            const bounds: RecordedRect = { x: px, y: py, w: T, h: T };
            if (isUniform(cell)) {
              expect(rects, `${hook} ${label}: uniform cell must draw nothing`).toHaveLength(0);
              continue;
            }
            const forbidden = forbiddenRects(cell, facePass, bandPx);
            for (const r of rects) {
              expect(r.w > 0 && r.h > 0, `${hook} ${label}: empty rect ${JSON.stringify(r)}`).toBe(true);
              const inside = r.x >= bounds.x && r.y >= bounds.y && r.x + r.w <= bounds.x + bounds.w && r.y + r.h <= bounds.y + bounds.h;
              expect(inside, `${hook} ${label}: rect ${JSON.stringify(r)} leaves the cell ${JSON.stringify(bounds)}`).toBe(true);
              for (const f of forbidden) {
                expect(intersects(r, f.rect), `${hook} ${label}: rect ${JSON.stringify(r)} touches ${f.why}`).toBe(false);
              }
            }
          }
        });
      }
    }

    it('paintWallBase consumes exactly the rand() draws of paintWall(faceVisible=false) and fills the tile', () => {
      const base = theme.paintWallBase!;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const px = (seed % 7) * T;
        const py = (seed % 5) * T;
        const expected = countDraws((rand) => theme.paintWall(makeBoundsGraphics().g, px, py, false, rand), seed);
        const actual = countDraws((rand) => base(makeBoundsGraphics().g, px, py, rand), seed);
        expect(actual, `seed ${seed}: paintWallBase draws`).toBe(expected);
      }
      const { g, rects } = makeBoundsGraphics();
      base(g, T, T, mulberry32(1));
      const full = rects.some((r) => r.x <= T && r.y <= T && r.x + r.w >= 2 * T && r.y + r.h >= 2 * T);
      expect(full, 'paintWallBase must draw at least the full-tile fill').toBe(true);
    });
  });
}
