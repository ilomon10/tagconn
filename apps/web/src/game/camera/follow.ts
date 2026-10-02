// apps/web/src/game/camera/follow.ts  (M17 7.1: pure follow step with a deadzone and exponential lag)
import { centerInSafeRect, clampScrollToSafeBounds, safeViewportRect, type SafeInsets } from './insets';

export interface FollowInput {
  /** World px (the scene passes `(c.x, c.y - 8)`). */
  target: { x: number; y: number };
  scrollX: number;
  scrollY: number;
  camWidth: number;
  camHeight: number;
  zoom: number;
  insets: SafeInsets;
  worldW: number;
  worldH: number;
  /** Fraction of the safe viewport the target may roam before the camera moves; 0 = always centred. */
  deadzone: number;
  lagMs: number;
  dtMs: number;
  /** Reduced motion, or the first frame after `setFollow`: land in one step. */
  instant: boolean;
}

const EPS = 1e-6;

/**
 * Deadzone = the safe rect shrunk to `deadzone` of its size about its centre. Inside: no change. Outside: the desired scroll puts the
 * target on the nearest deadzone edge per axis (not the centre), then `scroll += (desired - scroll) * a` with
 * `a = instant || lagMs === 0 ? 1 : 1 - exp(-dtMs / lagMs)`, then `clampScrollToSafeBounds`. Phaser's scroll convention (see insets.ts).
 */
export function followStep(i: FollowInput): { scrollX: number; scrollY: number; moved: boolean } {
  const safe = safeViewportRect(i.camWidth, i.camHeight, i.insets);
  const dz = Math.min(Math.max(i.deadzone, 0), 1);
  const halfW = (safe.w * dz) / 2 / i.zoom;
  const halfH = (safe.h * dz) / 2 / i.zoom;
  // World point at the safe centre = scroll + offset; centerInSafeRect(0, 0) returns -offset.
  const off = centerInSafeRect(0, 0, i.camWidth, i.camHeight, i.zoom, i.insets);
  const cx = i.scrollX - off.scrollX;
  const cy = i.scrollY - off.scrollY;
  const dx = i.target.x - cx;
  const dy = i.target.y - cy;
  const wantCx = Math.abs(dx) > halfW ? i.target.x - Math.sign(dx) * halfW : cx;
  const wantCy = Math.abs(dy) > halfH ? i.target.y - Math.sign(dy) * halfH : cy;
  const a = i.instant || i.lagMs <= 0 ? 1 : 1 - Math.exp(-Math.max(i.dtMs, 0) / i.lagMs);
  const wantX = i.scrollX + (wantCx - cx) * a;
  const wantY = i.scrollY + (wantCy - cy) * a;
  const c = clampScrollToSafeBounds(wantX, wantY, { camWidth: i.camWidth, camHeight: i.camHeight, zoom: i.zoom, worldW: i.worldW, worldH: i.worldH, insets: i.insets });
  return { scrollX: c.scrollX, scrollY: c.scrollY, moved: Math.abs(c.scrollX - i.scrollX) > EPS || Math.abs(c.scrollY - i.scrollY) > EPS };
}
