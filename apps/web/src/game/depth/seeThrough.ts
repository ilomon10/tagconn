// M17 D3: which tall sprites hide a character (docs/design/depth-25d.md sections 3.5 and 5). Pure, allocation-free per query.
import { MAX_OVERDRAW_PX } from '../procgen/backWallSpec';
import type { Rect } from '../procgen/types';
import { DEPTH_EPSILON, SEE_THROUGH_MIN_HEIGHT, SPRITE_MARGIN } from './tables';
import type { FurnitureSprite, SeeThroughIndex } from './types';

/** World-px rect a sprite can actually cover: the footprint plus the side/bottom margins, and above it only the painter's overdraw
 *  (at most `MAX_OVERDRAW_PX`, and only against a north wall), so a character just north of a free-standing rack hides nothing. */
function coverOf(s: FurnitureSprite, T: number): [number, number, number, number] {
  const up = s.item.againstNorthWall ? MAX_OVERDRAW_PX : 0;
  return [s.x, s.item.y * T - up, s.item.w * T + 2 * SPRITE_MARGIN.side, up + s.item.h * T + SPRITE_MARGIN.bottom];
}

/** Per-tile CSR bucket (tile -> indices into `sprites`) of the sprites that may fade: whole sprites (no strips) at or above `minHeight`. */
export function buildSeeThroughIndex(
  sprites: readonly FurnitureSprite[],
  cols: number,
  rows: number,
  T: number,
  minHeight: number = SEE_THROUGH_MIN_HEIGHT,
): SeeThroughIndex {
  const cells = Math.max(0, cols * rows);
  const start = new Int32Array(cells + 1);
  const span = (s: FurnitureSprite): [number, number, number, number] | null => {
    if (s.strip !== null || !(s.height >= minHeight)) return null;
    const [cx, cy, w, h] = coverOf(s, T);
    if (!(w > 0) || !(h > 0)) return null;
    return [
      Math.max(0, Math.floor(cx / T)),
      Math.min(cols - 1, Math.floor((cx + w - 1e-6) / T)),
      Math.max(0, Math.floor(cy / T)),
      Math.min(rows - 1, Math.floor((cy + h - 1e-6) / T)),
    ];
  };
  for (const s of sprites) {
    const b = span(s);
    if (!b) continue;
    for (let ty = b[2]; ty <= b[3]; ty++) for (let tx = b[0]; tx <= b[1]; tx++) start[tx + ty * cols + 1]!++;
  }
  for (let c = 0; c < cells; c++) start[c + 1]! += start[c]!;
  const items = new Int32Array(start[cells] ?? 0);
  const fill = start.slice(0, cells);
  sprites.forEach((s, i) => {
    const b = span(s);
    if (!b) return;
    for (let ty = b[2]; ty <= b[3]; ty++) for (let tx = b[0]; tx <= b[1]; tx++) items[fill[tx + ty * cols]!++] = i;
  });
  return { cols, rows, T, sprites, start, items };
}

/** The head/torso box that must stay visible: `(x - 4, y - 18, 8, 12)` in world px (feet at `(x, y)`). Writes into `out`. */
export function headRectOf(x: number, y: number, out: Rect): Rect {
  out.x = x - 4;
  out.y = y - 18;
  out.w = 8;
  out.h = 12;
  return out;
}

/** A character's occluders: sprites in the index whose frame rect intersects `head` and whose depth (`baseY - DEPTH_EPSILON`)
 *  is greater than `feetY` (the character is behind them). Writes sprite indices into `out` (no duplicates), returns the count
 *  (at most `out.length`). */
export function occludersOf(index: SeeThroughIndex, head: Rect, feetY: number, out: Int32Array): number {
  const { cols, rows, T, sprites, start, items } = index;
  const tx0 = Math.max(0, Math.floor(head.x / T));
  const tx1 = Math.min(cols - 1, Math.floor((head.x + head.w) / T));
  const ty0 = Math.max(0, Math.floor(head.y / T));
  const ty1 = Math.min(rows - 1, Math.floor((head.y + head.h) / T));
  let n = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const c = tx + ty * cols;
      for (let k = start[c]!; k < start[c + 1]!; k++) {
        const i = items[k]!;
        const s = sprites[i]!;
        if (!(s.baseY - DEPTH_EPSILON > feetY)) continue;
        const [fx, fy, fw, fh] = coverOf(s, T);
        if (head.x >= fx + fw || head.x + head.w <= fx || head.y >= fy + fh || head.y + head.h <= fy) continue;
        let dup = false;
        for (let j = 0; j < n; j++) if (out[j] === i) { dup = true; break; }
        if (dup) continue;
        if (n >= out.length) return n;
        out[n++] = i;
      }
    }
  }
  return n;
}
