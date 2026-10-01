import type { Rect } from './insets';

/**
 * Pure math for the M12 selection beacon (the arrow + ring over the selected character, and the
 * edge arrow pointing at it while it is off-screen). Plain numbers only, so it is unit-testable
 * without Phaser.
 */

/**
 * Local scale that keeps a beacon piece at a constant on-screen size when zoomed OUT (1/zoom), and at
 * its natural world size when zoomed in (it then grows with the map like the character does).
 * Unlike `labels/lod.ts#counterScale` there is deliberately NO cap: the beacon must stay findable at
 * the lowest zoom.
 */
export function beaconScale(zoom: number): number {
  if (!(zoom > 0)) return 1;
  return Math.max(1, 1 / zoom);
}

export interface CameraView {
  scrollX: number;
  scrollY: number;
  zoom: number;
  camWidth: number;
  camHeight: number;
}

/** Screen px of a world point (Phaser's origin-0.5 camera: scroll is offset from the viewport centre). */
export function worldToScreen(cam: CameraView, wx: number, wy: number): { x: number; y: number } {
  return {
    x: (wx - cam.scrollX - cam.camWidth / 2) * cam.zoom + cam.camWidth / 2,
    y: (wy - cam.scrollY - cam.camHeight / 2) * cam.zoom + cam.camHeight / 2,
  };
}

export interface EdgeArrow {
  /** True when the target lies outside `safe`; the rest is only meaningful then. */
  offscreen: boolean;
  /** Arrow position (screen px) on the safe rect's edge, `margin` px inside it. */
  x: number;
  y: number;
  /** Direction from the safe rect's centre to the target, radians (0 = right, y down). */
  angle: number;
}

/** Where to draw the "it is over there" arrow for a target at screen point (`sx`, `sy`). */
export function edgeArrowPlacement(sx: number, sy: number, safe: Rect, margin: number): EdgeArrow {
  const inside = sx >= safe.x && sx <= safe.x + safe.w && sy >= safe.y && sy <= safe.y + safe.h;
  const cx = safe.x + safe.w / 2;
  const cy = safe.y + safe.h / 2;
  const dx = sx - cx;
  const dy = sy - cy;
  const angle = Math.atan2(dy, dx);
  if (inside) return { offscreen: false, x: sx, y: sy, angle };
  const hw = Math.max(0, safe.w / 2 - margin);
  const hh = Math.max(0, safe.h / 2 - margin);
  const t = Math.min(dx === 0 ? Infinity : hw / Math.abs(dx), dy === 0 ? Infinity : hh / Math.abs(dy));
  return { offscreen: true, x: cx + dx * t, y: cy + dy * t, angle };
}
