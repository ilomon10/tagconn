/**
 * A tiny, deliberately independent re-implementation of the slice of Phaser's camera math this
 * package's `insets.ts`/`zoom.ts` have to agree with (origin fixed at 0.5, no rotation — the only
 * configuration this app uses). Ported by hand from `Phaser.Cameras.Scene2D.Camera#preRender` and
 * `BaseCamera#centerOnX`/`#centerOnY` (see `node_modules/phaser/src/cameras/2d/{Camera,BaseCamera}.js`),
 * not copied from this app's own camera code, so tests written against it catch a real regression
 * from Phaser's actual behavior rather than merely re-asserting whatever this app's math already does.
 *
 * The key, easy-to-miss fact both source files encode: `scrollX`/`scrollY` are offset from the
 * *world point shown at the viewport's center* by exactly `camWidth / 2`/`camHeight / 2` — in
 * screen px, never divided by zoom. Only the distance from a screen point to that center is a true
 * screen-space distance, so only that part gets divided by zoom when converting to world units.
 */
export interface PhaserCamera {
  scrollX: number;
  scrollY: number;
  zoom: number;
  camWidth: number;
  camHeight: number;
}

/** Mirrors `Camera#preRender`'s `worldView` computation. */
export function worldView(cam: PhaserCamera): { x: number; y: number; w: number; h: number } {
  const midX = cam.scrollX + cam.camWidth / 2;
  const midY = cam.scrollY + cam.camHeight / 2;
  const w = cam.camWidth / cam.zoom;
  const h = cam.camHeight / cam.zoom;
  return { x: midX - w / 2, y: midY - h / 2, w, h };
}

/** Mirrors `BaseCamera#centerOnX`/`#centerOnY`: no bounds, no zoom division. */
export function centerOn(camWidth: number, camHeight: number, x: number, y: number): { scrollX: number; scrollY: number } {
  return { scrollX: x - camWidth / 2, scrollY: y - camHeight / 2 };
}

/** The world point shown at a given screen point, linear within `worldView` (rotation 0). */
export function screenToWorld(cam: PhaserCamera, screenX: number, screenY: number): { x: number; y: number } {
  const wv = worldView(cam);
  return { x: wv.x + screenX / cam.zoom, y: wv.y + screenY / cam.zoom };
}
