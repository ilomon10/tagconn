// M16 L2: furniture drop shadows and per-character cast shadows (docs/design/lighting.md section 2.6). Pure.
import type { GeneratedMap, Point } from '../procgen/types';
import { WALL_HEIGHT_PX, kindHeight } from './heights';
import type { Occluders } from './occluders';
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

/**
 * M17 day shadows of walls (docs/design/depth-25d.md section 3.6). Every wall/floor boundary tile edge whose floor side lies in the
 * shadow direction (`sunShadowVector(sun, WALL_HEIGHT_PX, T)`: south always, east or west by the sun's skew) is extruded along the
 * vector as a parallelogram, runs of equal orientation merged. The extrusion is shortened until its far edge sits on floor/door
 * tiles, like furniture shadows. Alpha `shadowAlpha * 0.8 * daylight`. Nothing at night (room lights are inside the room).
 */
export function wallShadows(map: GeneratedMap, occluders: Occluders, sun: SunState, shadowAlpha: number): ShadowQuad[] {
  const out: ShadowQuad[] = [];
  const base = Number.isFinite(shadowAlpha) ? Math.max(0, shadowAlpha) : 0;
  if (!(base > 0) || !(sun.daylight > 0.5)) return out;
  const T = map.tileSize;
  const v = sunShadowVector(sun, WALL_HEIGHT_PX, T);
  if (!(v.y > 0 || v.x !== 0)) return out;
  const alpha = base * 0.8 * sun.daylight;
  const tiles = map.tiles;
  const wall = (tx: number, ty: number): boolean => tiles[ty]?.[tx] === 'wall';
  const open = (tx: number, ty: number): boolean => {
    const t = tiles[ty]?.[tx];
    return t === 'floor' || t === 'door';
  };

  // Emits the parallelogram of the run [a, b] (world px along the edge) on the fixed line `c`. The part that would slide past the
  // run's ends (into the corner walls) is trimmed off the near edge, and the extrusion is shortened until the far edge is on floor.
  const emit = (horizontal: boolean, c: number, a: number, b: number): void => {
    const along = horizontal ? v.x : v.y;
    const across = horizontal ? v.y : v.x;
    for (let k = 1; k > 0; k -= 0.25) {
      const a0 = Math.max(a, a - along * k);
      const b0 = Math.min(b, b - along * k);
      if (!(b0 - a0 > 1)) return;
      const far = c + across * k;
      // Probe half a pixel inside the far edge's ends so a corner on a tile boundary is judged by the tile the shadow covers.
      const u0 = a0 + along * k + 0.5;
      const u1 = b0 + along * k - 0.5;
      const um = (u0 + u1) / 2;
      const ok = horizontal
        ? isFloor(map, u0, far) && isFloor(map, u1, far) && isFloor(map, um, far)
        : isFloor(map, far, u0) && isFloor(map, far, u1) && isFloor(map, far, um);
      if (!ok) continue;
      const P = (u: number, d: number) => (horizontal ? { x: u, y: c + across * d } : { x: c + across * d, y: u });
      out.push({ points: [P(a0, 0), P(b0, 0), P(b0 + along * k, k), P(a0 + along * k, k)], alpha });
      return;
    }
  };

  for (let i = 0; i < occluders.wallCount; i++) {
    const s = occluders.segments[i]!;
    if (s.y1 === s.y2) {
      // Horizontal edge between rows ty - 1 and ty. Shadows go south: the wall must be above, the floor below.
      if (!(v.y > 0)) continue;
      const ty = Math.round(s.y1 / T);
      const t0 = Math.round(Math.min(s.x1, s.x2) / T);
      const t1 = Math.round(Math.max(s.x1, s.x2) / T);
      let start = -1;
      for (let tx = t0; tx <= t1; tx++) {
        const on = tx < t1 && wall(tx, ty - 1) && open(tx, ty);
        if (on && start < 0) start = tx;
        else if (!on && start >= 0) {
          emit(true, ty * T, start * T, tx * T);
          start = -1;
        }
      }
    } else {
      // Vertical edge between columns tx - 1 and tx. East shadow (vx > 0): wall on the west; west shadow: wall on the east.
      if (v.x === 0) continue;
      const tx = Math.round(s.x1 / T);
      const t0 = Math.round(Math.min(s.y1, s.y2) / T);
      const t1 = Math.round(Math.max(s.y1, s.y2) / T);
      let start = -1;
      for (let ty = t0; ty <= t1; ty++) {
        const on = ty < t1 && (v.x > 0 ? wall(tx - 1, ty) && open(tx, ty) : wall(tx, ty) && open(tx - 1, ty));
        if (on && start < 0) start = ty;
        else if (!on && start >= 0) {
          emit(false, tx * T, start * T, ty * T);
          start = -1;
        }
      }
    }
  }
  return out;
}
