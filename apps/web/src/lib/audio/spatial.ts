import type { Point } from '../../game/procgen/types';
import type { SfxListenerPose } from '../../game/sfxBus';

/** Max stereo pan for a source at the view edge. */
const PAN_MAX = 0.6;

/** 1 inside the central half of the view, linear to 0 at 1.25 x the half-diagonal. */
export function spatialGain(at: Point, l: SfxListenerPose): number {
  const dx = Math.abs(at.x - l.x);
  const dy = Math.abs(at.y - l.y);
  if (dx <= l.halfW / 2 && dy <= l.halfH / 2) return 1;
  const inner = Math.hypot(l.halfW / 2, l.halfH / 2);
  const outer = 1.25 * Math.hypot(l.halfW, l.halfH);
  if (outer <= inner) return 0;
  // Distance from the centre of the view; the inner radius is the corner of the central rectangle.
  const d = Math.hypot(dx, dy);
  return Math.min(1, Math.max(0, (outer - d) / (outer - inner)));
}

export function spatialPan(at: Point, l: SfxListenerPose): number {
  if (l.halfW <= 0) return 0;
  return Math.min(1, Math.max(-1, (at.x - l.x) / l.halfW)) * PAN_MAX;
}
