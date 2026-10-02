// M16 L2: furniture drop shadows and per-character cast shadows (docs/design/lighting.md section 2.6). Pure.
import type { GeneratedMap, Point } from '../procgen/types';
import { kindHeight } from './heights';
import { sunShadowVector } from './sun';
import type { CastShadow, LightmapLight, ShadowQuad, SunState } from './types';


/** Per-tile candidate lights (CSR): tile c holds `items[start[c] .. start[c + 1])`, indices into `lights`. */
export interface LightIndex {
  cols: number;
  rows: number;
  T: number;
  lights: readonly LightmapLight[];
  start: Int32Array;
  items: Int32Array;
}

/** Height of a character for its shadow vector, px. */
const CHARACTER_HEIGHT = 16;
const CHARACTER_DAY_ALPHA = 0.26;
const CHARACTER_LIGHT_ALPHA = 0.26;
const MIN_LEN = 6;
const MAX_LEN = 14;

/** Index of the lights by the tiles their reach covers, built once per plan. */
export function buildLightIndex(lights: readonly LightmapLight[], cols: number, rows: number, T: number): LightIndex {
  const cells = Math.max(0, cols * rows);
  const start = new Int32Array(cells + 1);
  const span = (l: LightmapLight): [number, number, number, number] => [
    Math.max(0, Math.floor((l.x - l.reach) / T)),
    Math.min(cols - 1, Math.floor((l.x + l.reach) / T)),
    Math.max(0, Math.floor((l.y - l.reach) / T)),
    Math.min(rows - 1, Math.floor((l.y + l.reach) / T)),
  ];
  const usable = (l: LightmapLight): boolean => l.reach > 0 && Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.reach);
  for (const l of lights) {
    if (!usable(l)) continue;
    const [x0, x1, y0, y1] = span(l);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) start[tx + ty * cols + 1]!++;
  }
  for (let c = 0; c < cells; c++) start[c + 1]! += start[c]!;
  const items = new Int32Array(start[cells] ?? 0);
  const fill = start.slice(0, cells);
  lights.forEach((l, i) => {
    if (!usable(l)) return;
    const [x0, x1, y0, y1] = span(l);
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) items[fill[tx + ty * cols]!++] = i;
  });
  return { cols, rows, T, lights, start, items };
}

/** Best light for `(x, y)` by `strength / (1 + d / reach)` among those whose reach covers the point (index 0-based, -1 = none).
 *  `skipBelow` ignores lights closer than that (a lamp's own footprint). Allocation-free. */
function bestLight(index: LightIndex, x: number, y: number, skipBelow: number): number {
  const tx = Math.floor(x / index.T);
  const ty = Math.floor(y / index.T);
  if (tx < 0 || ty < 0 || tx >= index.cols || ty >= index.rows) return -1;
  const c = tx + ty * index.cols;
  let best = -1;
  let bestScore = 0;
  for (let k = index.start[c]!; k < index.start[c + 1]!; k++) {
    const i = index.items[k]!;
    const l = index.lights[i]!;
    const d = Math.hypot(x - l.x, y - l.y);
    if (d > l.reach || d < skipBelow) continue;
    const score = l.strength / (1 + d / l.reach);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

const isFloor = (map: Pick<GeneratedMap, 'tiles' | 'tileSize'>, x: number, y: number): boolean => {
  const t = map.tiles[Math.floor(y / map.tileSize)]?.[Math.floor(x / map.tileSize)];
  return t === 'floor' || t === 'door';
};

/**
 * Drop shadows of every furniture item with a height: the footprint's south edge (north edge when the vector points north)
 * extruded along the shadow vector, as a parallelogram. The vector is `sunShadowVector` by day (`daylight > 0.5`); at night it
 * points away from the nearest `ambient-fill`/`point` light within reach, `height * 0.6` long (an item with no such light gets the
 * blob). Alpha `shadowAlpha * (0.5 + 0.5 * max(daylight, nearestStrength))`. `blob` = an unskewed 1-px-inset strip at `alpha * 0.6`.
 * The extrusion is shortened until its far edge sits on floor/door tiles: a shadow never climbs a wall.
 */
export function furnitureShadows(map: GeneratedMap, sun: SunState, lights: readonly LightmapLight[], mode: 'blob' | 'cast', shadowAlpha: number): ShadowQuad[] {
  const out: ShadowQuad[] = [];
  const T = map.tileSize;
  const base = Number.isFinite(shadowAlpha) ? Math.max(0, shadowAlpha) : 0;
  if (!(base > 0)) return out;
  const day = sun.daylight > 0.5;
  const lamps = mode === 'cast' && !day ? lights.filter((l) => l.kind === 'ambient-fill' || l.kind === 'point') : [];
  const index = lamps.length > 0 ? buildLightIndex(lamps, map.cols, map.rows, T) : null;

  for (const f of map.furniture) {
    const height = kindHeight(f.kind);
    if (!(height > 0)) continue;
    const x0 = f.x * T;
    const x1 = (f.x + f.w) * T;
    const y0 = f.y * T;
    const y1 = (f.y + f.h) * T;
    let vx = 0;
    let vy = 0;
    let strength = 0;
    let cast = false;
    if (mode === 'cast') {
      if (day) {
        const v = sunShadowVector(sun, height, T);
        vx = v.x;
        vy = v.y;
        cast = vx !== 0 || vy !== 0;
      } else if (index) {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const li = bestLight(index, cx, cy, 1);
        if (li >= 0) {
          const l = lamps[li]!;
          const d = Math.hypot(cx - l.x, cy - l.y);
          vx = ((cx - l.x) / d) * height * 0.6;
          vy = ((cy - l.y) / d) * height * 0.6;
          strength = l.strength;
          cast = true;
        }
      }
    }
    const alpha = Math.min(base, base * (0.5 + 0.5 * Math.max(sun.daylight, strength)));
    if (!cast) {
      const yb = y1;
      out.push({
        points: [
          { x: x0 + 1, y: yb - 2 },
          { x: x1 - 1, y: yb - 2 },
          { x: x1 - 1, y: yb + 2 },
          { x: x0 + 1, y: yb + 2 },
        ],
        alpha: alpha * 0.6,
      });
      continue;
    }
    const ey = vy >= 0 ? y1 : y0;
    // Shorten until the far corners and the far-edge midpoint are on floor (never climb a wall).
    let k = 1;
    for (; k > 0; k -= 0.25) {
      const fy = ey + vy * k;
      if (isFloor(map, x0 + vx * k, fy) && isFloor(map, x1 + vx * k, fy) && isFloor(map, (x0 + x1) / 2 + vx * k, fy)) break;
    }
    if (!(k > 0)) continue;
    out.push({
      points: [
        { x: x0, y: ey },
        { x: x1, y: ey },
        { x: x1 + vx * k, y: ey + vy * k },
        { x: x0 + vx * k, y: ey + vy * k },
      ],
      alpha,
    });
  }
  return out;
}

/**
 * Per character per frame (allocation-free: writes into `out`). Dominant light = the sun by day (`daylight > 0.5`), else the
 * strongest `strength / (1 + d / reach)` light covering the feet (per-tile `LightIndex`). `len` in px (6..14), direction
 * away from the light; alpha fades with distance. `blob` or no light: `{0, 0, 0, 0}`.
 */
export function characterShadow(feet: Point, sun: SunState, index: LightIndex, mode: 'blob' | 'cast', out: CastShadow): CastShadow {
  out.dx = 0;
  out.dy = 0;
  out.len = 0;
  out.alpha = 0;
  if (mode !== 'cast') return out;
  if (sun.daylight > 0.5) {
    const v = sunShadowVector(sun, CHARACTER_HEIGHT, index.T);
    const m = Math.hypot(v.x, v.y);
    if (!(m > 0)) return out;
    out.dx = v.x / m;
    out.dy = v.y / m;
    out.len = Math.max(MIN_LEN, Math.min(MAX_LEN, m));
    out.alpha = CHARACTER_DAY_ALPHA * sun.daylight;
    return out;
  }
  const li = bestLight(index, feet.x, feet.y, 0);
  if (li < 0) return out;
  const l = index.lights[li]!;
  const dx = feet.x - l.x;
  const dy = feet.y - l.y;
  const d = Math.hypot(dx, dy);
  const f = Math.max(0, 1 - d / l.reach);
  if (d < 1e-6) {
    out.dy = 1;
  } else {
    out.dx = dx / d;
    out.dy = dy / d;
  }
  out.len = MIN_LEN + (MAX_LEN - MIN_LEN) * f;
  out.alpha = CHARACTER_LIGHT_ALPHA * Math.min(1, l.strength) * f;
  return out;
}
