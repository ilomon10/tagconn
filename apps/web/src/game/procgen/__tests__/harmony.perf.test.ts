import { describe, expect, it } from 'vitest';
import type { FurnishDensity, RoomType } from '@tagconn/shared';
import { furnishRoom, type FurnishContext } from '../recipes';
import { mulberry32 } from '../rng';

/**
 * M16 F1 micro-benchmark (furnishing.md invariant 5): the group recipe with K candidates against the legacy per-type recipe,
 * per room, on the rooms a 128x96 / 64-room layout actually has (about 14x10 interiors at the default `normal` density).
 * Wall-clock, so it lives in `*.perf.test.ts` (`pnpm test:perf`). The ceiling is absolute and generous; the recorded numbers
 * (see the F1 hand-off) are what F5 compares against generate.perf's median.
 */
const CTX: FurnishContext = { aprons: new Set<string>(), wallSides: new Set(['n', 'e', 's', 'w'] as const), pinned: [], consumedSlots: new Set<string>() };
const TYPES: RoomType[] = ['desks', 'server-room', 'qa-lab', 'library', 'meeting-room', 'lounge', 'review-booth', 'whiteboard', 'entrance', 'pm-office'];

function msPerRoom(withCtx: boolean, density: FurnishDensity, w: number, h: number): number {
  const reps = 20;
  const t0 = performance.now();
  for (let rep = 0; rep < reps; rep++) {
    for (const t of TYPES) furnishRoom(t, { x: 0, y: 0, w, h }, mulberry32(rep), { density, decor: 0.35, aisle: 1 }, withCtx ? CTX : undefined);
  }
  return (performance.now() - t0) / (reps * TYPES.length);
}

describe('furnishRoom perf (group recipe)', () => {
  it('stays well under a millisecond per room at the default density', () => {
    msPerRoom(true, 'normal', 14, 10); // warm up
    const samples = [0, 1, 2, 3, 4].map(() => msPerRoom(true, 'normal', 14, 10)).sort((a, b) => a - b);
    const legacy = [0, 1, 2].map(() => msPerRoom(false, 'normal', 14, 10)).sort((a, b) => a - b);
    console.log(`furnishRoom normal 14x10: groups ${samples[2]!.toFixed(3)} ms/room, legacy ${legacy[1]!.toFixed(3)} ms/room`);
    expect(samples[2]!).toBeLessThan(1);
  });

  it('a big packed room is still cheap', () => {
    const big = msPerRoom(true, 'packed', 28, 18);
    console.log(`furnishRoom packed 28x18: ${big.toFixed(3)} ms/room`);
    expect(big).toBeLessThan(5);
  });
});
