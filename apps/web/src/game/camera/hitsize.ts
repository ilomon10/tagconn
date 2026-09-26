/**
 * WCAG 2.5.8 ("Target Size (Minimum)") click-target math for the office's zoomable camera (M9 8f).
 * Pure so it can be unit tested without Phaser. `worldSizePx` is an object's *smaller* side, in
 * *world* px (not screen px) — e.g. the Character hit rect's 14px width, or a stairs zone's tile
 * size. At the current camera `zoom` that side renders as `worldSizePx * zoom` screen px; once
 * that's already >= the minimum (default 24 CSS px), no growth is needed and the scale is 1. Below
 * it, the returned factor — applied to an object's *interactive hit area only*, never its visible
 * art — grows the rendered hit area back up to the minimum, clamped to 8x so an object never
 * swallows unreasonably more of the map than it needs to at extreme zoom-out.
 */
export function hitScaleFor(worldSizePx: number, zoom: number, minScreenPx = 24): number {
  if (!(worldSizePx > 0) || !(zoom > 0)) return 1;
  const screenPx = worldSizePx * zoom;
  if (screenPx >= minScreenPx) return 1;
  return Math.min(8, Math.max(1, minScreenPx / screenPx));
}
