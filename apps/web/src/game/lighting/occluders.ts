// M16 L2: what blocks light (docs/design/lighting.md section 2.3). Pure. Walls come from `map.tiles` (the boundary between a
// wall and a floor/door tile, merged into runs; void never occludes: a cliff edge is open sky), tall furniture from
// `map.furniture` (four sides per rect). Soft items never occlude.
import type { GeneratedMap, Point, TileKind } from '../procgen/types';
import { KIND_HEIGHT, OCCLUDER_MIN_HEIGHT_PX, kindHeight } from './heights';
import type { Segment } from './types';


/** A tall furniture rect (world px) and the index of its first segment (its four sides are contiguous). */
export interface OccluderBox {
  x: number;
  y: number;
  w: number;
  h: number;
  first: number;
}

export interface Occluders {
  /** Merged wall/floor boundary runs, then the four sides of every tall furniture rect (`boxes[i]` owns `wallCount + 4 i ..+3`). */
  segments: Segment[];
  wallCount: number;
  boxes: OccluderBox[];
  cols: number;
  rows: number;
  tileSize: number;
  tiles: TileKind[][];
  /** Uniform grid of segment indices by tile (`cell = tx + ty * cols`) in CSR form: cell c holds
   *  `cellItems[cellStart[c] .. cellStart[c + 1])`. One flat pair of typed arrays instead of one array per tile (12k tiles). */
  cellStart: Int32Array;
  cellItems: Int32Array;
  /** Query scratch (dedupe stamps): `segmentIndicesNear` is not re-entrant. */
  stamp: Int32Array;
  gen: { n: number };
}

export type OccluderMap = Pick<GeneratedMap, 'cols' | 'rows' | 'tileSize' | 'tiles' | 'furniture'>;

const isWall = (tiles: TileKind[][], x: number, y: number): boolean => tiles[y]?.[x] === 'wall';
const isOpen = (tiles: TileKind[][], x: number, y: number): boolean => {
  const t = tiles[y]?.[x];
  return t === 'floor' || t === 'door';
};
/** A wall/open boundary between two tiles (either order). */
const edgeBetween = (tiles: TileKind[][], ax: number, ay: number, bx: number, by: number): boolean =>
  (isWall(tiles, ax, ay) && isOpen(tiles, bx, by)) || (isOpen(tiles, ax, ay) && isWall(tiles, bx, by));

export function buildOccluders(map: OccluderMap, heights: Readonly<Record<string, number>> = KIND_HEIGHT): Occluders {
  const { cols, rows, tileSize: T, tiles } = map;
  const segments: Segment[] = [];

  // Horizontal runs: the line between tile rows y-1 and y, for y in 1..rows-1 (the grid edge borders nothing).
  for (let y = 1; y < rows; y++) {
    let start = -1;
    for (let x = 0; x <= cols; x++) {
      const on = x < cols && edgeBetween(tiles, x, y - 1, x, y);
      if (on && start < 0) start = x;
      else if (!on && start >= 0) {
        segments.push({ x1: start * T, y1: y * T, x2: x * T, y2: y * T });
        start = -1;
      }
    }
  }
  // Vertical runs: the line between tile columns x-1 and x.
  for (let x = 1; x < cols; x++) {
    let start = -1;
    for (let y = 0; y <= rows; y++) {
      const on = y < rows && edgeBetween(tiles, x - 1, y, x, y);
      if (on && start < 0) start = y;
      else if (!on && start >= 0) {
        segments.push({ x1: x * T, y1: start * T, x2: x * T, y2: y * T });
        start = -1;
      }
    }
  }
  const wallCount = segments.length;

  const boxes: OccluderBox[] = [];
  for (const f of map.furniture) {
    if (kindHeight(f.kind, heights) < OCCLUDER_MIN_HEIGHT_PX) continue;
    const x = f.x * T;
    const y = f.y * T;
    const w = f.w * T;
    const h = f.h * T;
    if (!(w > 0) || !(h > 0)) continue;
    boxes.push({ x, y, w, h, first: segments.length });
    segments.push(
      { x1: x, y1: y, x2: x + w, y2: y },
      { x1: x + w, y1: y, x2: x + w, y2: y + h },
      { x1: x, y1: y + h, x2: x + w, y2: y + h },
      { x1: x, y1: y, x2: x, y2: y + h },
    );
  }

  // Bucket by tile (CSR, two passes). A segment on a tile boundary belongs to both neighbours: pad the bbox by 1 px.
  const cells = Math.max(0, cols * rows);
  const range = (s: Segment): [number, number, number, number] => [
    Math.max(0, Math.floor((Math.min(s.x1, s.x2) - 1) / T)),
    Math.min(cols - 1, Math.floor((Math.max(s.x1, s.x2) + 1) / T)),
    Math.max(0, Math.floor((Math.min(s.y1, s.y2) - 1) / T)),
    Math.min(rows - 1, Math.floor((Math.max(s.y1, s.y2) + 1) / T)),
  ];
  const cellStart = new Int32Array(cells + 1);
  for (const s of segments) {
    const [x0, x1, y0, y1] = range(s);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) cellStart[tx + ty * cols + 1]!++;
  }
  for (let c = 0; c < cells; c++) cellStart[c + 1]! += cellStart[c]!;
  const cellItems = new Int32Array(cellStart[cells] ?? 0);
  const fill = cellStart.slice(0, cells);
  segments.forEach((s, i) => {
    const [x0, x1, y0, y1] = range(s);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) cellItems[fill[tx + ty * cols]!++] = i;
  });

  return { segments, wallCount, boxes, cols, rows, tileSize: T, tiles, cellStart, cellItems, stamp: new Int32Array(segments.length), gen: { n: 0 } };
}

/** Distance from `p` to the axis-aligned bounding box of `s`. */
function distToSegmentBox(s: Segment, px: number, py: number): number {
  const dx = Math.max(Math.min(s.x1, s.x2) - px, 0, px - Math.max(s.x1, s.x2));
  const dy = Math.max(Math.min(s.y1, s.y2) - py, 0, py - Math.max(s.y1, s.y2));
  return Math.hypot(dx, dy);
}

/** Indices of the segments whose bounding box touches the disc (origin, radius), via the bucket. */
export function segmentIndicesNear(o: Occluders, origin: Point, radius: number): number[] {
  const out: number[] = [];
  const T = o.tileSize;
  if (!(radius >= 0) || !Number.isFinite(origin.x) || !Number.isFinite(origin.y) || o.cols <= 0 || o.rows <= 0) return out;
  const x0 = Math.max(0, Math.floor((origin.x - radius) / T));
  const x1 = Math.min(o.cols - 1, Math.floor((origin.x + radius) / T));
  const y0 = Math.max(0, Math.floor((origin.y - radius) / T));
  const y1 = Math.min(o.rows - 1, Math.floor((origin.y + radius) / T));
  const gen = ++o.gen.n;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const c = tx + ty * o.cols;
      for (let k = o.cellStart[c]!; k < o.cellStart[c + 1]!; k++) {
        const i = o.cellItems[k]!;
        if (o.stamp[i] === gen) continue;
        o.stamp[i] = gen;
        if (distToSegmentBox(o.segments[i]!, origin.x, origin.y) <= radius) out.push(i);
      }
    }
  }
  return out;
}

/** Segments whose bounding box intersects the disc (origin, radius). */
export function segmentsNear(o: Occluders, origin: Point, radius: number): Segment[] {
  return segmentIndicesNear(o, origin, radius).map((i) => o.segments[i]!);
}

/** What a light at `origin` should be cast against: `segmentsNear` minus the four sides of any tall furniture rect the
 *  origin sits inside (a lamp, a fireplace or a rack's LED is not blocked by its own body). */
export function segmentsForLight(o: Occluders, origin: Point, radius: number): Segment[] {
  const out: Segment[] = [];
  for (const i of segmentIndicesNear(o, origin, radius)) {
    if (i >= o.wallCount) {
      const b = o.boxes[(i - o.wallCount) >> 2];
      if (b && origin.x >= b.x && origin.x <= b.x + b.w && origin.y >= b.y && origin.y <= b.y + b.h) continue;
    }
    out.push(o.segments[i]!);
  }
  return out;
}

/** A light origin inside a wall tile (a torch or window on the wall face) is nudged `T / 2 + 1` towards the floor side (south,
 *  north, east, then west) so it lights its room instead of being swallowed by its own wall. Anything else is returned as is. */
export function nudgeIntoFloor(tiles: TileKind[][], T: number, p: Point): Point {
  const tx = Math.floor(p.x / T);
  const ty = Math.floor(p.y / T);
  if (!isWall(tiles, tx, ty)) return p;
  const d = T / 2 + 1;
  if (isOpen(tiles, tx, ty + 1)) return { x: p.x, y: p.y + d };
  if (isOpen(tiles, tx, ty - 1)) return { x: p.x, y: p.y - d };
  if (isOpen(tiles, tx + 1, ty)) return { x: p.x + d, y: p.y };
  if (isOpen(tiles, tx - 1, ty)) return { x: p.x - d, y: p.y };
  return p;
}
