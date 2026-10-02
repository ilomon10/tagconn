import { describe, expect, it } from 'vitest';
import type { PlacedFurniture } from '../../procgen/types';
import { ATLAS_PADDING, packFrames } from '../pack';
import { ATLAS_MAX_HEIGHT, ATLAS_WIDTH } from '../tables';
import type { FrameSpec } from '../types';

const item: PlacedFurniture = { x: 0, y: 0, w: 1, h: 1, kind: 'bookcase', blocking: true, roomId: 'r', roomType: 'desks', variant: 0 };
const spec = (key: string, w: number, h: number): FrameSpec => ({ key, themeId: 'modern', item, w, h });

function lcg(seed: number) {
  let a = seed;
  return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const randomFrames = (n: number, seed: number): FrameSpec[] => {
  const r = lcg(seed);
  return Array.from({ length: n }, (_v, i) => spec(`k${i}`, 20 + Math.floor(r() * 5) * 16, 20 + Math.floor(r() * 4) * 16));
};

function expectValid(frames: FrameSpec[]) {
  const layout = packFrames(frames);
  expect(layout.frames.size).toBe(frames.length);
  const placed = [...layout.frames.values()];
  for (const p of placed) {
    const page = layout.pages[p.page]!;
    expect(page).toBeDefined();
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.x + p.w).toBeLessThanOrEqual(page.w);
    expect(p.y + p.h).toBeLessThanOrEqual(page.h);
  }
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]!;
      const b = placed[j]!;
      if (a.page !== b.page) continue;
      // a 1 px gutter stays between neighbours
      const apart = a.x + a.w + ATLAS_PADDING <= b.x || b.x + b.w + ATLAS_PADDING <= a.x || a.y + a.h + ATLAS_PADDING <= b.y || b.y + b.h + ATLAS_PADDING <= a.y;
      expect(apart, `${a.key} vs ${b.key}`).toBe(true);
    }
  return layout;
}

describe('packFrames', () => {
  it('has no overlaps, keeps every frame inside its page, pages are powers of two within the limits', () => {
    for (const n of [1, 7, 60, 400]) {
      const layout = expectValid(randomFrames(n, n));
      for (const p of layout.pages) {
        expect(p.w).toBe(ATLAS_WIDTH);
        expect(p.h).toBeLessThanOrEqual(ATLAS_MAX_HEIGHT);
        expect(Math.log2(p.h) % 1).toBe(0);
      }
      expect(layout.pages.length).toBeLessThanOrEqual(2);
    }
  });

  it('is deterministic and ignores input order', () => {
    const frames = randomFrames(120, 3);
    const a = packFrames(frames);
    const b = packFrames([...frames].reverse());
    expect(JSON.stringify([...a.frames].sort())).toBe(JSON.stringify([...b.frames].sort()));
    expect(a.pages).toEqual(b.pages);
  });

  it('starts a new page at ATLAS_MAX_HEIGHT', () => {
    const frames = Array.from({ length: 100 }, (_v, i) => spec(`t${String(i).padStart(3, '0')}`, 1000, 500));
    const layout = expectValid(frames);
    expect(layout.pages.length).toBe(25);
    expect(layout.pages.every((p) => p.h <= ATLAS_MAX_HEIGHT)).toBe(true);
    const tall = Array.from({ length: 7 }, (_v, i) => spec(`u${i}`, 300, 700));
    expect(expectValid(tall).pages.length).toBe(2); // 3 per row, 701 px per row: two rows fit in 2048, the third row opens a second page
  });

  it('handles degenerate input', () => {
    expect(packFrames([])).toEqual({ pages: [], frames: new Map() });
    const huge = packFrames([spec('huge', 3000, 3000), spec('small', 20, 20)]);
    expect(huge.frames.get('huge')).toMatchObject({ x: 0, y: 0, w: 3000, h: 3000 });
    expect(huge.pages[huge.frames.get('huge')!.page]).toEqual({ w: 4096, h: 4096 });
    expect(huge.pages[huge.frames.get('small')!.page]!.w).toBe(ATLAS_WIDTH);
    expectValid([spec('a', 1, 1)]);
  });
});
