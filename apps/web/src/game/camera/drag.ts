/** Pointer movement below this (CSS px) is still a click; at or beyond it, a pan/drag. */
export const DRAG_THRESHOLD_PX = 4;

/** Whether a pointer that moved (dx, dy) since pointerdown counts as a drag rather than a click. */
export function isDragMove(dx: number, dy: number, threshold = DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(dx, dy) >= threshold;
}
