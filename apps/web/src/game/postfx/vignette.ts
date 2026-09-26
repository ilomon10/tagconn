// apps/web/src/game/postfx/vignette.ts  (M9: edge vignette — pure TS mirror of VignettePipeline's GLSL)
//
// Kept dependency-free (no Phaser) so the maths can be unit tested from vitest's node environment,
// same convention as grading.ts/quality.ts. `VignettePipeline`'s fragment shader is a line-for-line
// GLSL port of the functions below — if you change one, change the other.
//
// The vignette only lives in a frame along the screen edges, like a UI vignette: `t` is 0 everywhere
// inside an inner rectangle inset by `band` screen px, and rises to 1 at the edge. Corners get a rounded
// inner edge (distance to the inner rectangle), so they read slightly darker, as a real lens would.

/** Width of the vignette frame in screen px: `size` (a fraction of the shorter side) of the viewport. */
export function vignetteBandPx(width: number, height: number, size: number): number {
  return Math.max(1, Math.min(width, height) * size);
}

/** 0 inside the clean middle, rising to 1 at (and beyond) the screen edge. `x`/`y` in screen px. */
export function vignetteT(x: number, y: number, width: number, height: number, band: number): number {
  const qx = Math.max(Math.abs(x - width / 2) - (width / 2 - band), 0);
  const qy = Math.max(Math.abs(y - height / 2) - (height / 2 - band), 0);
  return Math.min(1, Math.sqrt(qx * qx + qy * qy) / band);
}

/** `style: 'smooth'` — a soft ease-in from the inner edge to full `strength` at the screen edge. */
export function smoothVignetteShade(t: number, strength: number): number {
  const s = t * t * (3 - 2 * t); // smoothstep
  return s * s * strength;
}

/** `style: 'pixel'` — hard bands, no dithering: 4 steps → the frame shows 25%, 50%, 75% and 100% of
 *  `strength` from the inside out; the middle (t = 0) stays at 0. */
export function pixelVignetteShade(t: number, steps: number, strength: number): number {
  return (Math.max(0, Math.ceil(t * steps - 1e-6)) / steps) * strength;
}

/** Snaps a screen-px coordinate to the centre of its block — block size = `pixelSize` art px times the
 *  camera `zoom`, in screen px — so the bands are drawn on the art's own pixel grid at any zoom. */
export function blockCenterPx(screenX: number, screenY: number, pixelSize: number, zoom: number): { x: number; y: number } {
  const block = Math.max(1, pixelSize * zoom);
  return { x: (Math.floor(screenX / block) + 0.5) * block, y: (Math.floor(screenY / block) + 0.5) * block };
}
