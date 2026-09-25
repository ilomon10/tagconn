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
