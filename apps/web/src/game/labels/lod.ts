export interface LabelVisibilityInput {
  /** The camera's current zoom. */
  zoom: number;
  /** `office.labelMinZoom` — below this, only "important" characters keep their tag/bubble. */
  minZoom: number;
  /** Selected, waiting-for-you/blocked, or currently hovered — the caller folds all three in. */
  important: boolean;
}

/**
 * Level of detail by zoom (ROADMAP.md M8 8e): below `minZoom`, name tags and bubbles hide except
 * for the selected or waiting/blocked characters, and reappear on hover (the caller ORs `hovered`
 * into `important` before calling this).
 */
export function labelVisible({ zoom, minZoom, important }: LabelVisibilityInput): boolean {
  return zoom >= minZoom || important;
}

/**
 * Screen-space readability (ROADMAP.md M8 8e "labels don't scale below a readable size when
 * zoomed out"): the local scale a label needs so it never reads smaller on screen than it would
 * at zoom 1, even as the camera zooms out below that — without also blowing it up further once
 * the camera zooms *in* past 1 (which already reads bigger on its own). `maxScale` caps how far a
 * very low zoom can inflate it.
 */
export function counterScale(zoom: number, maxScale = 2.5): number {
  if (zoom <= 0) return maxScale;
  return Math.min(maxScale, Math.max(1, 1 / zoom));
}
