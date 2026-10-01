// Pure transition geometry (docs/design/battles.md 3.5): the entry swirl (black wedges rotating and growing from the
// centre) and the iris that opens or closes on the stage. Both return polygons the scene fills black.
import type { Point } from './stageLayout';

export type Polygon = Point[];

const smooth = (t: number): number => t * t * (3 - 2 * t);
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
/** Radius that covers the whole screen from its centre, with slack for chord sag on the arcs. */
const coverRadius = (w: number, h: number): number => Math.hypot(w, h) / 2 * 1.1;
const ARC_STEPS = 6;

/** `count` black wedges. t = 0 → nothing; t = 1 → the whole screen is covered. */
export function swirlWedges(t: number, w: number, h: number, count = 8): Polygon[] {
  const u = clamp01(t);
  if (u <= 0 || count < 1) return [];
  const e = smooth(u);
  const cx = w / 2;
  const cy = h / 2;
  const radius = coverRadius(w, h) * e;
  const sector = (Math.PI * 2) / count;
  // Full width at t = 1 plus a hair of overlap so neighbours leave no seam.
  const width = sector * e + (u >= 1 ? 0.004 : 0);
  const rot = (1 - e) * Math.PI * 0.75; // spins in while growing
  const out: Polygon[] = [];
  for (let i = 0; i < count; i++) {
    const a0 = rot + i * sector;
    const poly: Polygon = [{ x: cx, y: cy }];
    for (let s = 0; s <= ARC_STEPS; s++) {
      const a = a0 + (width * s) / ARC_STEPS;
      poly.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
    }
    out.push(poly);
  }
  return out;
}

/** The black area OUTSIDE a circle of radius `r` around the centre (r = 0 → all black, r ≥ cover radius → empty). */
export function irisPolygons(r: number, w: number, h: number, segs = 32): Polygon[] {
  const outer = coverRadius(w, h) * 1.05;
  if (r >= outer) return [];
  const cx = w / 2;
  const cy = h / 2;
  const rr = Math.max(0, r);
  const step = (Math.PI * 2) / segs;
  const out: Polygon[] = [];
  for (let i = 0; i < segs; i++) {
    const a0 = i * step;
    const a1 = a0 + step + 0.002;
    // Outer edge is pushed past the chord sag so the quads still cover the corners.
    const ro = outer / Math.cos(step / 2);
    out.push([
      { x: cx + Math.cos(a0) * rr, y: cy + Math.sin(a0) * rr },
      { x: cx + Math.cos(a0) * ro, y: cy + Math.sin(a0) * ro },
      { x: cx + Math.cos(a1) * ro, y: cy + Math.sin(a1) * ro },
      { x: cx + Math.cos(a1) * rr, y: cy + Math.sin(a1) * rr },
    ]);
  }
  return out;
}

/** Iris radius that fully reveals the screen. */
export const irisFullRadius = (w: number, h: number): number => coverRadius(w, h) * 1.05;
