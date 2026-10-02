import { HALF_TILE } from '@tagconn/shared';

/**
 * Snap guides for the Furniture drag (docs/design/furnishing.md section 6.4). Pure: all rects share one
 * coordinate space (the caller uses interior-relative tiles), and nothing here touches the store or canvas.
 */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapResult {
  x: number;
  y: number;
  guides: { axis: 'x' | 'y'; at: number }[];
}

/** Default snap tolerance, in tiles. */
export const SNAP_TOL = 0.5;

const EPS = 1e-6;
const onHalfGrid = (v: number) => Math.abs(v / HALF_TILE - Math.round(v / HALF_TILE)) < EPS;

/** The three lines of a span: start, centre, end. */
const lines = (start: number, len: number): number[] => [start, start + len / 2, start + len];

/**
 * Best shift for one axis: the smallest move (within `tol`) that lines one of the dragged span's edges or
 * centre up with a target line. Only shifts that keep the position on the half-tile grid count, so a snap
 * never produces a pin the schema would reject. Returns 0 when nothing is close.
 */
function bestShift(start: number, len: number, targets: readonly number[], tol: number): number {
  let best = 0;
  let bestAbs = Infinity;
  for (const mine of lines(start, len)) {
    for (const t of targets) {
      const d = t - mine;
      const a = Math.abs(d);
      if (a > tol + EPS || a >= bestAbs - EPS || !onHalfGrid(start + d)) continue;
      best = d;
      bestAbs = a;
    }
  }
  return best;
}

/**
 * Snaps a dragged rect's edges/centre to other items' edges/centres and the interior's edges within `tol`
 * (after the caller's half-tile snap). `guides` lists every target line the snapped rect now sits on, for
 * the canvas to draw. The result is NOT clamped: the caller re-clamps with `clampPinPos`.
 */
export function snapRect(rect: Rect, others: readonly Rect[], interior: Rect, tol: number = SNAP_TOL): SnapResult {
  const xs = [interior.x, interior.x + interior.w];
  const ys = [interior.y, interior.y + interior.h];
  for (const o of others) {
    xs.push(...lines(o.x, o.w));
    ys.push(...lines(o.y, o.h));
  }
  const x = rect.x + bestShift(rect.x, rect.w, xs, tol);
  const y = rect.y + bestShift(rect.y, rect.h, ys, tol);
  const guides: SnapResult['guides'] = [];
  const seen = new Set<string>();
  const add = (axis: 'x' | 'y', at: number) => {
    const key = `${axis}${at}`;
    if (seen.has(key)) return;
    seen.add(key);
    guides.push({ axis, at });
  };
  const mineX = lines(x, rect.w);
  const mineY = lines(y, rect.h);
  for (const t of xs) if (mineX.some((m) => Math.abs(m - t) < EPS)) add('x', t);
  for (const t of ys) if (mineY.some((m) => Math.abs(m - t) < EPS)) add('y', t);
  return { x, y, guides };
}
