// Test helper: the 128x96 worst-case layout (copied from procgen/__tests__/generate.perf.test.ts,
// which does not export it). Used by the nav property and perf suites.
import { LAYOUT_LIMITS, type LayoutRoom, type OfficeLayout, type OfficeLayoutInput } from '@tagconn/shared';

/**
 * A 128x96 layout packed with the full `maxRooms` (64) rooms: an entrance, a stairs landing, and 62
 * `desks` rooms tiled across the grid. Built directly (not via the BSP "surprise me" generator) so
 * the perf test always exercises the documented worst case regardless of how the BSP happens to
 * size its rooms.
 */
export function maxRoomsLayout(): OfficeLayoutInput {
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
  if (rooms.length !== LAYOUT_LIMITS.maxRooms) throw new Error(`maxRoomsLayout: expected ${LAYOUT_LIMITS.maxRooms} rooms, got ${rooms.length}`);
  return { name: 'perf', width, height, seed: 1, background: 'void', corridorWidth: 2, rooms };
}

/** An `OfficeLayoutInput` as the persisted `OfficeLayout` `generateMap` takes (the pattern of the procgen tests). */
export function toLayout(input: OfficeLayoutInput, id: string): OfficeLayout {
  return {
    ...input,
    background: input.background ?? 'hall',
    corridorWidth: input.corridorWidth ?? 2,
    id,
    builtin: false,
    createdAt: 0,
    updatedAt: 0,
  };
}
