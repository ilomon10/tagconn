import type { Point, Rect, TileKind } from './types';

export type Side = 'top' | 'bottom' | 'left' | 'right';

export const SIDE_DIR: Record<Side, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export interface DoorRoomShape {
  id: string;
  footprint: Rect;
  walled: boolean;
}

/** A candidate door opening: a run of contiguous wall-ring tiles all leading to the same region. */
export interface DoorSpan {
  roomId: string;
  side: Side;
  /** Region id reached by stepping outward through the wall (or double wall). */
  toRegionId: number;
  /** 1 = single wall between the two floors; 2 = a double wall shared with another walled room. */
  depth: 1 | 2;
  /** Wall tiles on `roomId`'s ring, in order along the side. */
  positions: Point[];
}

/**
 * Perimeter tiles of a footprint, excluding the 4 corners, tagged with their side. For a walled
 * room these are the wall ring; for an open room they are the outermost floor tiles (also used by
 * corridors.ts to find void-facing exits).
 */
export function* footprintRing(r: Rect): Generator<{ p: Point; side: Side }> {
  const x2 = r.x + r.w - 1;
  const y2 = r.y + r.h - 1;
  for (let x = r.x + 1; x < x2; x++) {
    yield { p: { x, y: r.y }, side: 'top' };
  }
  for (let x = r.x + 1; x < x2; x++) {
    yield { p: { x, y: y2 }, side: 'bottom' };
  }
  for (let y = r.y + 1; y < y2; y++) {
    yield { p: { x: r.x, y }, side: 'left' };
  }
  for (let y = r.y + 1; y < y2; y++) {
    yield { p: { x: x2, y }, side: 'right' };
  }
}

/**
 * Door candidates between walled rooms and their neighbouring region (guild-hall.md section 4, step 5).
 * For every non-corner ring tile, look one tile outward: floor there is a single-thick candidate. A
 * wall there with floor one tile further is a double-thick candidate (two rooms sharing a wall, each
 * with its own ring). Contiguous same-target candidates along a side are grouped into one span.
 */
export function findDoorSpans(
  rooms: readonly DoorRoomShape[],
  tiles: readonly TileKind[][],
  regionAt: readonly (number | null)[][],
): DoorSpan[] {
  const rows = tiles.length;
  const cols = tiles[0]?.length ?? 0;
  const inBounds = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows;
  const spans: DoorSpan[] = [];

  for (const room of rooms) {
    if (!room.walled) continue;
    let sideCursor: Side | null = null;
    let run: Point[] = [];
    let runTarget: { region: number; depth: 1 | 2 } | null = null;

    const flush = () => {
      if (run.length && runTarget && sideCursor) {
        spans.push({ roomId: room.id, side: sideCursor, toRegionId: runTarget.region, depth: runTarget.depth, positions: run });
      }
      run = [];
      runTarget = null;
    };

    for (const { p, side } of footprintRing(room.footprint)) {
      if (side !== sideCursor) flush();
      sideCursor = side;
      const dir = SIDE_DIR[side];
      const out1 = { x: p.x + dir.x, y: p.y + dir.y };
      let target: { region: number; depth: 1 | 2 } | null = null;
      if (inBounds(out1) && tiles[out1.y]![out1.x] === 'floor') {
        const rid = regionAt[out1.y]?.[out1.x];
        if (rid != null) target = { region: rid, depth: 1 };
      } else if (inBounds(out1) && tiles[out1.y]![out1.x] === 'wall') {
        const out2 = { x: p.x + dir.x * 2, y: p.y + dir.y * 2 };
        if (inBounds(out2) && tiles[out2.y]![out2.x] === 'floor') {
          const rid = regionAt[out2.y]?.[out2.x];
          if (rid != null) target = { region: rid, depth: 2 };
        }
      }
      const sameTarget = target && runTarget && target.region === runTarget.region && target.depth === runTarget.depth;
      if (!target) {
        flush();
      } else if (!sameTarget) {
        flush();
        runTarget = target;
        run = [p];
      } else {
        run.push(p);
      }
    }
    flush();
  }
  return spans;
}
