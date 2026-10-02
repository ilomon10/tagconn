// apps/web/src/game/camera/snap.ts  (M17 7.2: integer zoom so art pixels stay crisp)
export const SNAP_ZOOM_MIN = 0.2;
export const SNAP_ZOOM_MAX = 6;

/**
 * `integer`: zoom >= 1 becomes a whole number (`fit` rounds down so the map still fits; `round` for wheel/pinch lands on the nearest
 * stop); zoom < 1 stays continuous (phones must fit a floor). Off = identity (still clamped to [0.2, 6]).
 */
export function snapZoom(zoom: number, integer: boolean, mode: 'fit' | 'round'): number {
  const z = Math.min(Math.max(zoom, SNAP_ZOOM_MIN), SNAP_ZOOM_MAX);
  if (!integer || z < 1) return z;
  const s = mode === 'fit' ? Math.floor(z + 1e-9) : Math.round(z);
  return Math.min(Math.max(s, 1), SNAP_ZOOM_MAX);
}
