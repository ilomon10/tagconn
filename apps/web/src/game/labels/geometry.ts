import type { Point, Size } from './types';

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** A box whose bottom-center sits at `anchor` — matches a speech bubble's tail pointing down at its subject. */
export function rectFromBox(anchor: Point, box: Size): Rect {
  return { left: anchor.x - box.w / 2, right: anchor.x + box.w / 2, top: anchor.y - box.h, bottom: anchor.y };
}

/** Axis-aligned overlap test, with `padding` extra clearance required on every side. */
export function rectsOverlap(a: Rect, b: Rect, padding = 0): boolean {
  return a.left < b.right + padding && a.right + padding > b.left && a.top < b.bottom + padding && a.bottom + padding > b.top;
}
