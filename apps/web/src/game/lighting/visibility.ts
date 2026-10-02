// M16 L2: visibility polygons for the lightmap (docs/design/lighting.md section 2.3). Pure.
import type { Point } from '../procgen/types';
import type { Segment } from './types';

export const BASE_RAYS = 48;
/** More rays than this (a light in a forest of tiny segments) falls back to the plain radius circle: bounded work per light. */
export const MAX_RAYS_PER_LIGHT = 512;
const EPS_ANGLE = 1e-4;
const TAU = Math.PI * 2;

/** The plain disc polygon (`BASE_RAYS` vertices): used when there is nothing to hit or the ray budget is exceeded. */
export function circlePolygon(origin: Point, radius: number, n = BASE_RAYS): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push({ x: origin.x + Math.cos(a) * radius, y: origin.y + Math.sin(a) * radius });
  }
  return out;
}

/** Angular sweep: rays at `BASE_RAYS` even angles plus one ray per segment endpoint within `radius`, +- 1e-4 rad; each ray stops
 *  at the nearest segment hit or at `radius`; vertices sorted by angle (0..2 pi). Star-shaped around `origin`, so `clipToRadius`
 *  is exact per vertex. Degenerate input (radius <= 0, non-finite origin) is an empty polygon. */
export function visibilityPolygon(origin: Point, segments: readonly Segment[], radius: number): Point[] {
  if (!(radius > 0) || !Number.isFinite(radius) || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return [];
  if (segments.length === 0) return circlePolygon(origin, radius);
  const ox = origin.x;
  const oy = origin.y;

  const extra: number[] = [];
  const norm = (a: number): number => ((a % TAU) + TAU) % TAU;
  for (const s of segments) {
    if (Math.hypot(s.x1 - ox, s.y1 - oy) <= radius) {
      const a = Math.atan2(s.y1 - oy, s.x1 - ox);
      extra.push(norm(a - EPS_ANGLE), norm(a + EPS_ANGLE));
    }
    if (Math.hypot(s.x2 - ox, s.y2 - oy) <= radius) {
      const a = Math.atan2(s.y2 - oy, s.x2 - ox);
      extra.push(norm(a - EPS_ANGLE), norm(a + EPS_ANGLE));
    }
  }
  if (BASE_RAYS + extra.length > MAX_RAYS_PER_LIGHT * 2) return circlePolygon(origin, radius);
  const angles = new Float64Array(BASE_RAYS + extra.length);
  for (let i = 0; i < BASE_RAYS; i++) angles[i] = (i / BASE_RAYS) * TAU;
  for (let i = 0; i < extra.length; i++) angles[BASE_RAYS + i] = extra[i]!;
  angles.sort();
  // Shared endpoints repeat: drop angles closer than 1e-9 to the previous one.
  let n = 0;
  for (let i = 0; i < angles.length; i++) {
    if (n > 0 && angles[i]! - angles[n - 1]! < 1e-9) continue;
    angles[n++] = angles[i]!;
  }
  if (n > MAX_RAYS_PER_LIGHT) return circlePolygon(origin, radius);

  const out: Point[] = new Array<Point>(n);
  for (let k = 0; k < n; k++) {
    const dx = Math.cos(angles[k]!);
    const dy = Math.sin(angles[k]!);
    let best = radius;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]!;
      const ex = s.x2 - s.x1;
      const ey = s.y2 - s.y1;
      const denom = dx * ey - dy * ex;
      if (denom > -1e-12 && denom < 1e-12) continue;
      const px = s.x1 - ox;
      const py = s.y1 - oy;
      const t = (px * ey - py * ex) / denom;
      if (t <= 1e-9 || t >= best) continue;
      const u = (px * dy - py * dx) / denom;
      if (u < -1e-9 || u > 1 + 1e-9) continue;
      best = t;
    }
    out[k] = { x: ox + dx * best, y: oy + dy * best };
  }
  return out;
}

/** The polygon with every vertex pulled to `min(dist, r)` along its ray from `origin` (the ring at r for the gradient bands). */
export function clipToRadius(origin: Point, polygon: readonly Point[], r: number): Point[] {
  const out: Point[] = new Array<Point>(polygon.length);
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i]!;
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    const d = Math.hypot(dx, dy);
    if (d <= r || d === 0) out[i] = { x: p.x, y: p.y };
    else out[i] = { x: origin.x + (dx / d) * r, y: origin.y + (dy / d) * r };
  }
  return out;
}

/** True when `p` is inside the polygon (even-odd ray test). */
export function containsPoint(polygon: readonly Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
