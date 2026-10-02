// M17 D1: shelf packing of the furniture atlas frames (docs/design/depth-25d.md section 3.2). Pure and deterministic.
import { ATLAS_MAX_HEIGHT, ATLAS_WIDTH } from './tables';
import type { AtlasLayout, FrameSpec, PackedFrame } from './types';

/** Transparent gutter (px) right of and below every frame so a nearest/linear sample never bleeds a neighbour in. */
export const ATLAS_PADDING = 1;

const pow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/** Shelf packing: frames sorted by height desc then key; rows of `ATLAS_WIDTH`; a page grows to the next power of two up to
 *  `ATLAS_MAX_HEIGHT`, then a new page starts. A frame wider or taller than a page gets a page of its own (power-of-two sized).
 *  Deterministic; no frame overlaps; every frame inside its page (section 9 test 3). */
export function packFrames(frames: Iterable<FrameSpec>): AtlasLayout {
  const list = [...frames].sort((a, b) => b.h - a.h || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const pages: { w: number; h: number }[] = [];
  const placed = new Map<string, PackedFrame>();
  const oversize: FrameSpec[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  let usedH = 0;
  const closePage = () => {
    if (pages.length > 0 && usedH > 0) pages[pages.length - 1] = { w: ATLAS_WIDTH, h: pow2(usedH) };
  };
  const openPage = () => {
    closePage();
    pages.push({ w: ATLAS_WIDTH, h: 0 });
    x = y = rowH = usedH = 0;
  };
  for (const f of list) {
    const cw = f.w + ATLAS_PADDING;
    const ch = f.h + ATLAS_PADDING;
    if (cw > ATLAS_WIDTH || ch > ATLAS_MAX_HEIGHT) {
      oversize.push(f);
      continue;
    }
    if (pages.length === 0) openPage();
    if (x + cw > ATLAS_WIDTH) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    if (y + ch > ATLAS_MAX_HEIGHT) openPage();
    placed.set(f.key, { key: f.key, page: pages.length - 1, x, y, w: f.w, h: f.h });
    x += cw;
    rowH = Math.max(rowH, ch);
    usedH = Math.max(usedH, y + rowH);
  }
  closePage();
  for (const f of oversize) {
    placed.set(f.key, { key: f.key, page: pages.length, x: 0, y: 0, w: f.w, h: f.h });
    pages.push({ w: pow2(f.w + ATLAS_PADDING), h: pow2(f.h + ATLAS_PADDING) });
  }
  return { pages, frames: placed };
}
