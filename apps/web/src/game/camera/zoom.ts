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
 *
 * This assumes a "plain" scroll convention where `screenX = (worldX - scrollX) * zoom` — true of
 * the Hall Planner's 2D canvas view (`features/editor/PlanCanvas.tsx`, its only other caller), but
 * *not* of a Phaser camera (see `zoomCameraAboutPoint` below, and the note in `camera/insets.ts`,
 * for why Phaser's `scrollX`/`scrollY` need an extra `camWidth/2`/`camHeight/2` correction).
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

export interface FixedPositionForScreenPointInput {
  /** The screen point (camera-relative, e.g. a Phaser pointer's `x`/`y`) the object should render at. */
  screenX: number;
  screenY: number;
  zoom: number;
  camWidth: number;
  camHeight: number;
}

/**
 * Where to put a `setScrollFactor(0)` object's `x`/`y` so it renders at `(screenX, screenY)`
 * regardless of camera zoom.
 *
 * `scrollFactor(0)` cancels out `camera.scrollX`/`scrollY` (see `GetCalcMatrix`'s
 * `spriteMatrix.e -= camera.scrollX * src.scrollFactorX`, which is `-= 0` here), but it does *not*
 * cancel the camera's own render matrix (`Camera#preRender`'s `matrix.applyITRS(...)` +
 * `.translate(-originX, -originY)`, built with the default single main camera at `x = y = 0`):
 * with origin 0.5, that matrix maps an object's `x`/`y` to
 * `screen = camWidth/2 + (x - camWidth/2) * zoom` (and the same for y), i.e. it scales *about the
 * viewport center*, same as any other object. So a `setScrollFactor(0)` object still moves and
 * scales with zoom unless you correct for it — this is that correction, inverted so the object
 * lands exactly on the given screen point.
 */
export function fixedPositionForScreenPoint(input: FixedPositionForScreenPointInput): { x: number; y: number } {
  const { screenX, screenY, zoom, camWidth, camHeight } = input;
  return {
    x: camWidth / 2 + (screenX - camWidth / 2) / zoom,
    y: camHeight / 2 + (screenY - camHeight / 2) / zoom,
  };
}

export interface ZoomCameraAboutPointInput extends ZoomAboutPointInput {
  /** The Phaser camera's viewport size in screen px (`cam.width`/`cam.height`). */
  camWidth: number;
  camHeight: number;
}

/**
 * `zoomAboutPoint`'s counterpart for an actual Phaser camera. Phaser's `scrollX`/`scrollY` sit
 * `camWidth/2`/`camHeight/2` screen px — not world units — from the point they scroll to (see the
 * note in `camera/insets.ts`); only the delta between the pointer and that viewport center is a
 * real screen-space distance, so only it gets divided by zoom to convert to world units. Using the
 * plain `zoomAboutPoint` formula here (as the office scene used to) only kept the point under the
 * cursor fixed when zooming exactly at the viewport's center — which the mouse wheel rarely is.
 */
export function zoomCameraAboutPoint(input: ZoomCameraAboutPointInput): { scrollX: number; scrollY: number } {
  const { pointerX, pointerY, scrollX, scrollY, oldZoom, newZoom, camWidth, camHeight } = input;
  const worldX = scrollX + camWidth / 2 + (pointerX - camWidth / 2) / oldZoom;
  const worldY = scrollY + camHeight / 2 + (pointerY - camHeight / 2) / oldZoom;
  return {
    scrollX: worldX - camWidth / 2 - (pointerX - camWidth / 2) / newZoom,
    scrollY: worldY - camHeight / 2 - (pointerY - camHeight / 2) / newZoom,
  };
}
