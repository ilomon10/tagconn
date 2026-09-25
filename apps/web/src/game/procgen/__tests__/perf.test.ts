import { describe, expect, it } from 'vitest';
import { hasLayoutErrors, LAYOUT_LIMITS, type OfficeLayout, type OfficeLayoutInput, type LayoutRoom } from '@tagconn/shared';
import { generateMap } from '../generate';

/**
 * A 128x96 layout packed with the full `maxRooms` (64) rooms: an entrance, a stairs landing, and 62
 * `desks` rooms tiled across the grid. Built directly (not via the BSP "surprise me" generator) so
 * the perf test always exercises the documented worst case regardless of how the BSP happens to
 * size its rooms.
 */
function maxRoomsLayout(): OfficeLayoutInput {
  const width = 128;
  const height = 96;
  const cols = 8;
  const rows = 8;
  const cellW = Math.floor((width - 2) / cols);
  const cellH = Math.floor((height - 2) / rows);
  const rooms: LayoutRoom[] = [];
  let n = 0;
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const x = 1 + rx * cellW;
      const y = 1 + ry * cellH;
      const isFirst = ry === rows - 1 && rx === 0;
      const isSecond = ry === rows - 1 && rx === 1;
      rooms.push({
        id: `room${n++}`,
        type: isFirst ? 'entrance' : isSecond ? 'stairs' : 'desks',
        x,
        y,
        w: cellW,
        h: cellH,
      });
    }
  }
  expect(rooms.length).toBe(LAYOUT_LIMITS.maxRooms);
  return { name: 'perf', width, height, seed: 1, background: 'void', corridorWidth: 2, rooms };
}

/**
 * A grid split into a checkerboard of 32 rooms and 32 holes: `width`/`height` are chosen so
 * `(width - 2)` and `(height - 2)` divide evenly by the 8x8 grid, leaving zero leftover margin (a
 * remainder there would leave one contiguous strip of void along the far edge, connecting every
 * hole to every other and defeating the point). Orthogonal neighbours always flip checkerboard
 * parity, so every room is surrounded on all four sides by either a hole or the outer wall — never
 * another room — and each hole starts out as its own disconnected void area (`findVoidAreas` reports
 * 32 of them before any corridor is carved). The generator still manages to connect most of them in
 * the end (a hole borders up to 4 different rooms, and those rooms chain together through their
 * *other* holes), so this isn't a "stays disconnected" test — it's a "32 regions and 32 originally-
 * separate void areas is cheap, not a combinatorial trap" test: before `findVoidAreas`, `tryCorridor`
 * ran a full `astarVoid` search for every nearest-region pair regardless of whether the two exits
 * could ever reach each other; this construction exercises exactly that path many times over.
 */
function sealedVoidPocketsLayout(): OfficeLayoutInput {
  const width = 98; // (98 - 2) / 8 = 12, exactly
  const height = 66; // (66 - 2) / 8 = 8, exactly
  const cols = 8;
  const rows = 8;
  const cellW = (width - 2) / cols;
  const cellH = (height - 2) / rows;
  const rooms: LayoutRoom[] = [];
  let n = 0;
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      if ((rx + ry) % 2 !== 0) continue; // checkerboard: every other cell stays a sealed void pocket
      const x = 1 + rx * cellW;
      const y = 1 + ry * cellH;
      rooms.push({ id: `room${n}`, type: n === 0 ? 'entrance' : n === 1 ? 'stairs' : 'desks', x, y, w: cellW, h: cellH });
      n++;
    }
  }
  expect(rooms.length).toBe(32);
  return { name: 'sealed-pockets', width, height, seed: 7, background: 'void', corridorWidth: 2, rooms };
}

describe('perf budget: many sealed void pockets (security/perf hardening regression)', () => {
  it('generateMap stays fast and returns a well-formed map instead of hanging', () => {
    const input = sealedVoidPocketsLayout();
    const layout: OfficeLayout = {
      ...input,
      background: input.background ?? 'hall',
      corridorWidth: input.corridorWidth ?? 2,
      id: 'sealed-pockets',
      builtin: false,
      createdAt: 0,
      updatedAt: 0,
    };

    // Several samples + median (as the sibling test above does): a single sample is noisy under
    // shared-CI/JIT-warmup load, which isn't what this budget is meant to catch.
    const samples: number[] = [];
    let map: ReturnType<typeof generateMap> | undefined;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      map = generateMap(layout);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;

    expect(median).toBeLessThan(150);
    expect(map!.cols).toBe(input.width);
    expect(map!.rows).toBe(input.height);
    expect(Array.isArray(map!.issues)).toBe(true); // returns normally (with whatever it finds), never hangs or throws
  });
});

describe('perf budget', () => {
  it('generateMap(128x96, 64 rooms) stays well under budget (documented: <50ms median, enforced <150ms to avoid flakiness)', () => {
    const input = maxRoomsLayout();
    const layout: OfficeLayout = {
      ...input,
      background: input.background ?? 'hall',
      corridorWidth: input.corridorWidth ?? 2,
      id: 'perf',
      builtin: false,
      createdAt: 0,
      updatedAt: 0,
    };

    const samples: number[] = [];
    for (let i = 0; i < 9; i++) {
      const t0 = performance.now();
      const map = generateMap(layout);
      samples.push(performance.now() - t0);
      // Sanity: this is the real 64-room worst case, not an accidental fallback to DEFAULT_LAYOUT.
      expect(map.cols).toBe(128);
      expect(map.rows).toBe(96);
      expect(hasLayoutErrors(map.issues)).toBe(false);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)]!;
    expect(median).toBeLessThan(150);
  });
});
