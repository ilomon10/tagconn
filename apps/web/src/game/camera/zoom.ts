export interface ZoomAboutPointInput {
  /** Pointer position in camera-relative screen px (e.g. a Phaser pointer's `x`/`y`). */
  pointerX: number;
  pointerY: number;
  scrollX: number;
  scrollY: number;
  oldZoom: number;
  newZoom: number;
}

/**
 * Recompute scroll so the world point under (pointerX, pointerY) stays under the cursor after
 * zooming from `oldZoom` to `newZoom`. The insets only matter afterwards, when the caller clamps
 * the result with `clampScrollToSafeBounds`.
 */
export function zoomAboutPoint(input: ZoomAboutPointInput): { scrollX: number; scrollY: number } {
  const { pointerX, pointerY, scrollX, scrollY, oldZoom, newZoom } = input;
  const worldX = scrollX + pointerX / oldZoom;
  const worldY = scrollY + pointerY / oldZoom;
  return {
    scrollX: worldX - pointerX / newZoom,
    scrollY: worldY - pointerY / newZoom,
  };
}
