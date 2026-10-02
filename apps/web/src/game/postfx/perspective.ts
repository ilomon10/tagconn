// apps/web/src/game/postfx/perspective.ts  (M17 7.3: pure uniforms for the perspective post-pass; PerspectivePipeline.ts is the GLSL port)
export interface PerspectiveUniforms {
  k: number;
  hazeStrength: number;
  haze: [number, number, number];
  texel: number;
  /** Offset of the art-row boundaries from the top of the screen, in UV units (0 when the scroll is a whole number of art rows). */
  phase: number;
}

/** Compression of the top row at perspective = 1. */
export const PERSPECTIVE_K_MAX = 0.3;
export const PERSPECTIVE_HAZE_MAX = 0.18;

/**
 * k = perspective * K_MAX; hazeStrength = perspective * HAZE_MAX; haze = theme `palette.bg` as rgb 0..1; texel = zoom / viewportH
 * (one art row in UV units); phase = (scrollY * zoom mod zoom) / viewportH, where the art rows start when the camera scroll is fractional
 * (the snap is anchored to the art pixels, not to screen y = 0, so rows do not shimmer while following). perspective 0 -> k and hazeStrength are 0 (identity).
 */
export function perspectiveUniforms(perspective: number, zoom: number, viewportH: number, bgColor: number, scrollY = 0): PerspectiveUniforms {
  const p = Math.min(Math.max(Number.isFinite(perspective) ? perspective : 0, 0), 1);
  return {
    k: p * PERSPECTIVE_K_MAX,
    hazeStrength: p * PERSPECTIVE_HAZE_MAX,
    haze: [((bgColor >> 16) & 0xff) / 255, ((bgColor >> 8) & 0xff) / 255, (bgColor & 0xff) / 255],
    texel: viewportH > 0 ? zoom / viewportH : 0,
    phase: viewportH > 0 && zoom > 0 && Number.isFinite(scrollY) ? (((scrollY * zoom) % zoom) + zoom) % zoom / viewportH : 0,
  };
}

/** Source position (distance from the top, 0..1) for output position `t`. Mirrors the fragment shader before row snapping. */
export function perspectiveSource(t: number, k: number): number {
  return t + k * (t - t * t);
}

/**
 * Pointer events carry the unremapped screen position, but the pixel under the pointer shows source row `perspectiveSource(t, k)`.
 * Map a screen y (px from the top) to the y the game drew there, for hit tests. Ignores the whole-art-row snap (under one art row);
 * the drift without it is at most k * H / 4 px (about 6 px at the default 0.1 on an 800 px canvas).
 */
export function unproject(screenY: number, viewportH: number, k: number): number {
  if (viewportH <= 0) return screenY;
  return perspectiveSource(Math.min(Math.max(screenY / viewportH, 0), 1), k) * viewportH;
}
