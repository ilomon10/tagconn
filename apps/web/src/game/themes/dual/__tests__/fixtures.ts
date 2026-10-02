// Test fixtures for the dual grid (docs/design/dual-grid.md section 4.3). Shared by the D0 model tests, the
// painter harness (`paint/dual/__tests__/dualHarness.ts`) and the per-style painter tests (D1-D3).
import type { RoomType } from '@tagconn/shared';
import type { GeneratedMap, GeneratedRoom, Rect } from '../../../procgen/types';
import { BIT, maskOf, QUADRANTS, type CornerKind, type DualCell, type FloorKind, type Quadrant } from '../dualGrid';

export type DualMap = Pick<GeneratedMap, 'cols' | 'rows' | 'tiles' | 'rooms' | 'roomAt'>;

export interface RoomSpec {
  id: string;
  type: RoomType;
  /** Floor/door tiles inside this rect get `roomAt = id`. */
  rect: Rect;
}

/** The ASCII tile alphabet: `#` wall, `.` floor, `D` door, space void. */
function tileOfChar(ch: string): GeneratedMap['tiles'][number][number] {
  switch (ch) {
    case '#':
      return 'wall';
    case '.':
      return 'floor';
    case 'D':
      return 'door';
    case ' ':
      return 'void';
    default:
      throw new Error(`tilesFrom: unknown tile char ${JSON.stringify(ch)}`);
  }
}

/** Builds a map from ASCII rows (`#` wall, `.` floor, `D` door, space void). Short rows are padded with void. */
export function tilesFrom(rows: string[], rooms: RoomSpec[] = []): DualMap {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const tiles = rows.map((row) => Array.from({ length: cols }, (_, x) => tileOfChar(row[x] ?? ' ')));
  const roomAt: (string | null)[][] = tiles.map((row) => row.map(() => null));
  for (const room of rooms) {
    for (let y = room.rect.y; y < room.rect.y + room.rect.h; y++) {
      for (let x = room.rect.x; x < room.rect.x + room.rect.w; x++) {
        const t = tiles[y]?.[x];
        if (t === 'floor' || t === 'door') roomAt[y]![x] = room.id;
      }
    }
  }
  const generated: GeneratedRoom[] = rooms.map((r) => ({
    id: r.id,
    type: r.type,
    footprint: r.rect,
    interior: r.rect,
    walled: true,
    seats: [],
    tiles: [],
    labelAt: { x: r.rect.x, y: r.rect.y },
  }));
  return { cols, rows: rows.length, tiles, rooms: generated, roomAt };
}

/**
 * A small walled room (`desks`) with a south door, a corridor below it and a void margin: every boundary kind the
 * painters care about (wall/floor, wall/void, floor/void, door, inner and outer corners) in a 7 x 7 map.
 */
export function tinyMap(): DualMap {
  return tilesFrom(
    [
      '       ', //
      ' ##### ',
      ' #...# ',
      ' #...# ',
      ' ##D## ',
      ' ..... ',
      '       ',
    ],
    [{ id: 'r1', type: 'desks', rect: { x: 2, y: 2, w: 3, h: 3 } }],
  );
}

export interface CellOpts {
  cx?: number;
  cy?: number;
  /** Floor kind recorded for every floor/door quadrant (default `corridor`). */
  floorKind?: FloorKind;
  roomId?: string | null;
}

/**
 * A `DualCell` from a 4-char spec in `tl tr bl br` order using the `tilesFrom` alphabet: `cellFrom('##..')` is a
 * wall above floor (an edge with two face quadrants), `cellFrom('# D.')` has a void `tr` and a door `bl`.
 */
export function cellFrom(spec: string, opts: CellOpts = {}): DualCell {
  if (spec.length !== 4) throw new Error(`cellFrom: expected 4 chars (tl tr bl br), got ${JSON.stringify(spec)}`);
  const kinds = {} as Record<Quadrant, CornerKind>;
  let doorMask = 0;
  const floorKinds: Record<Quadrant, FloorKind | null> = { tl: null, tr: null, bl: null, br: null };
  const roomIds: Record<Quadrant, string | null> = { tl: null, tr: null, bl: null, br: null };
  QUADRANTS.forEach((q, i) => {
    const tile = tileOfChar(spec[i]!);
    kinds[q] = tile === 'void' ? 'void' : tile === 'wall' ? 'wall' : 'floor';
    if (tile === 'door') doorMask |= BIT[q];
    if (kinds[q] === 'floor') {
      floorKinds[q] = opts.floorKind ?? 'corridor';
      roomIds[q] = opts.roomId ?? null;
    }
  });
  return {
    cx: opts.cx ?? 1,
    cy: opts.cy ?? 1,
    kinds,
    wallMask: maskOf(kinds, 'wall'),
    floorMask: maskOf(kinds, 'floor'),
    voidMask: maskOf(kinds, 'void'),
    doorMask,
    floorKinds,
    roomIds,
  };
}

/** The 81 cells with every quadrant in {void, wall, floor} (no doors: see `withDoor`), spec attached for messages. */
export function allCornerCombos(opts: CellOpts = {}): { spec: string; cell: DualCell }[] {
  const chars = [' ', '#', '.'];
  const out: { spec: string; cell: DualCell }[] = [];
  for (const tl of chars) for (const tr of chars) for (const bl of chars) for (const br of chars) {
    const spec = tl + tr + bl + br;
    out.push({ spec, cell: cellFrom(spec, opts) });
  }
  return out;
}

/** A copy of `cell` with floor quadrant `q` marked as a door (`doorMask`); throws when `q` is not floor. */
export function withDoor(cell: DualCell, q: Quadrant): DualCell {
  if (!(cell.floorMask & BIT[q])) throw new Error(`withDoor: quadrant ${q} is not floor`);
  return { ...cell, doorMask: cell.doorMask | BIT[q] };
}
