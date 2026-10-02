// M16 L2: the lightmap plan (docs/design/lighting.md section 2.5). Pure: the Phaser layer (L4) only draws what this returns.
// Visibility polygons are baked once per map (`bakePolygons`); a sun step only re-runs `planLightmap`.
import type { GeneratedMap, GeneratedRoom, Point, Rect, WallDecorSlot } from '../procgen/types';
import type { ThemeDefinition } from '../themes/types';
import type { LightingSettings } from './clock';
import { nudgeIntoFloor, segmentsForLight, type Occluders } from './occluders';
import { lightingColours, type LightingColours } from './palette';
import { LIGHTMAP_MAX_LIGHTS, MAX_LIGHT_REACH_TILES, intensityAt } from './sources';
import type { GradientBand, LightingQuality, LightmapLight, LightmapPlan, PlannedLight, ShaftQuad, SunState } from './types';
import { visibilityPolygon } from './visibility';


export const BANDS_HIGH = 6;
export const BANDS_LOW = 3;
/** Multiverse: the rift void between realms stays at this fraction of the fill. */
export const VOID_AMBIENT = 0.25;
/** Lights dimmer than this (strength x intensity) are not planned: they would draw nothing visible. */
const MIN_VISIBLE = 0.01;
/** Falloff exponent of the cumulative band brightness. */
const FALLOFF = 1.6;

export interface PlanRegion {
  /** World px. */
  rect: Rect;
  theme: Pick<ThemeDefinition, 'id' | 'lighting'>;
}

export interface PlanInput {
  map: GeneratedMap;
  sun: SunState;
  sources: readonly LightmapLight[];
  /** From `bakePolygons` (once per map). */
  polygons: ReadonlyMap<LightmapLight, Point[]>;
  quality: LightingQuality;
  settings: Pick<LightingSettings, 'windowShafts'>;
  colours: Pick<LightingColours, 'sunColor' | 'moonColor'>;
  /** Multiverse realm rects (empty on a single floor). Shaft colours follow the realm's theme; the space between realms is dark. */
  regions: readonly PlanRegion[];
}

/** Scales each channel of `color` by `k` (0..1). */
export function scaleColour(color: number, k: number): number {
  const u = Math.max(0, Math.min(1, Number.isFinite(k) ? k : 0));
  const ch = (s: number): number => Math.round(((color >> s) & 0xff) * u);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** Visibility polygon of every source at its full reach (clamped to `MAX_LIGHT_REACH_TILES`), once per map. Truncates to
 *  `LIGHTMAP_MAX_LIGHTS[quality]` first so a hostile source list cannot drive unbounded sweeps. Each polygon is star-shaped
 *  around the light's position after `nudgeIntoFloor` (a no-op for `lightmapSources` output, which is already nudged). */
export function bakePolygons(
  sources: readonly LightmapLight[],
  occluders: Occluders,
  map: Pick<GeneratedMap, 'cols' | 'tileSize'>,
  quality: LightingQuality = 'high',
): Map<LightmapLight, Point[]> {
  const out = new Map<LightmapLight, Point[]>();
  const T = map.tileSize;
  const maxReach = MAX_LIGHT_REACH_TILES * T;
  const n = Math.min(sources.length, LIGHTMAP_MAX_LIGHTS[quality]);
  for (let i = 0; i < n; i++) {
    const l = sources[i]!;
    const reach = Math.min(l.reach, maxReach);
    const origin = nudgeIntoFloor(occluders.tiles, T, l);
    out.set(l, visibilityPolygon(origin, segmentsForLight(occluders, origin, reach), reach));
  }
  return out;
}

/** Concentric rings, outer to inner. Drawn additively, ring i adds `strength * ((i+1)/n)^1.6 - (i/n)^1.6`, so the
 *  brightness at depth j is `strength * (j/n)^1.6`: a stepped radial falloff peaking at `strength` in the centre. */
export function bandsFor(reach: number, strength: number, quality: LightingQuality): GradientBand[] {
  const n = quality === 'low' ? BANDS_LOW : BANDS_HIGH;
  const bands: GradientBand[] = [];
  for (let i = 0; i < n; i++) {
    const alpha = strength * (Math.pow((i + 1) / n, FALLOFF) - Math.pow(i / n, FALLOFF));
    if (alpha > 0.001) bands.push({ r: (reach * (n - i)) / n, alpha });
  }
  return bands;
}

/** A window's shaft: a parallelogram from the sill (the wall row's bottom edge over `span` tiles) going south by
 *  `len = T * (1 + 3 * (1 - elevation))` (moon: `1.5 T`), leaning `-skew * len * 0.6` in x, clipped to the room's interior
 *  rect (walls stop light; furniture does not, accepted). Colour sunColor by day / moonColor by night. */
export function shaftFor(
  slot: Pick<WallDecorSlot, 'kind' | 'x' | 'y' | 'span' | 'roomId'>,
  room: Pick<GeneratedRoom, 'interior'>,
  sun: SunState,
  colours: Pick<LightingColours, 'sunColor' | 'moonColor'>,
  T: number,
): ShaftQuad | null {
  if (slot.kind !== 'window') return null;
  const alpha = 0.16 * sun.daylight + 0.07 * sun.moon;
  if (!(alpha >= 0.004)) return null;
  const day = sun.daylight >= 0.5;
  const len0 = day ? T * (1 + 3 * (1 - sun.elevation)) : 1.5 * T;
  const lean = -sun.skew * len0 * 0.6;
  const ix0 = room.interior.x * T;
  const ix1 = (room.interior.x + room.interior.w) * T;
  const iy0 = room.interior.y * T;
  const iy1 = (room.interior.y + room.interior.h) * T;
  const y0 = (slot.y + 1) * T;
  const len = Math.min(len0, iy1 - y0);
  if (!(len > 0) || y0 < iy0 - 1) return null;
  const k = len / len0;
  const cx = (x: number): number => Math.max(ix0, Math.min(ix1, x));
  const xa = cx(slot.x * T);
  const xb = cx((slot.x + slot.span) * T);
  if (!(xb > xa)) return null;
  const l = lean * k;
  return {
    points: [
      { x: xa, y: y0 },
      { x: xb, y: y0 },
      { x: cx(xb + l), y: y0 + len },
      { x: cx(xa + l), y: y0 + len },
    ],
    color: day ? colours.sunColor : colours.moonColor,
    alpha,
    roomId: slot.roomId,
  };
}

/** The world minus the realm rects, as non-overlapping rects (coordinate-compressed cells, merged along x). */
export function voidRects(world: Rect, regions: readonly Rect[]): Rect[] {
  const xs = new Set<number>([world.x, world.x + world.w]);
  const ys = new Set<number>([world.y, world.y + world.h]);
  const clampX = (v: number): number => Math.max(world.x, Math.min(world.x + world.w, v));
  const clampY = (v: number): number => Math.max(world.y, Math.min(world.y + world.h, v));
  for (const r of regions) {
    xs.add(clampX(r.x));
    xs.add(clampX(r.x + r.w));
    ys.add(clampY(r.y));
    ys.add(clampY(r.y + r.h));
  }
  const X = [...xs].sort((a, b) => a - b);
  const Y = [...ys].sort((a, b) => a - b);
  const inside = (cx: number, cy: number): boolean => regions.some((r) => cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h);
  const out: Rect[] = [];
  for (let j = 0; j + 1 < Y.length; j++) {
    let run: Rect | null = null;
    for (let i = 0; i + 1 < X.length; i++) {
      const w = X[i + 1]! - X[i]!;
      const h = Y[j + 1]! - Y[j]!;
      const dark = w > 0 && h > 0 && !inside(X[i]! + w / 2, Y[j]! + h / 2);
      if (dark) {
        if (run) run.w += w;
        else run = { x: X[i]!, y: Y[j]!, w, h };
      } else if (run) {
        out.push(run);
        run = null;
      }
    }
    if (run) out.push(run);
  }
  return out;
}

export function planLightmap(input: PlanInput): LightmapPlan {
  const { map, sun, quality } = input;
  const T = map.tileSize;

  const fill = { color: scaleColour(sun.tint, sun.ambient) };

  const lights: PlannedLight[] = [];
  const n = Math.min(input.sources.length, LIGHTMAP_MAX_LIGHTS[quality]);
  for (let i = 0; i < n; i++) {
    const light = input.sources[i]!;
    const polygon = input.polygons.get(light);
    if (!polygon || polygon.length < 3) continue;
    const intensity = intensityAt(light, sun);
    if (light.strength * intensity < MIN_VISIBLE) continue;
    lights.push({ light, polygon, bands: bandsFor(Math.min(light.reach, MAX_LIGHT_REACH_TILES * T), light.strength * intensity, quality), intensity });
  }

  const shafts: ShaftQuad[] = [];
  if (input.settings.windowShafts) {
    const roomById = new Map(map.rooms.map((r) => [r.id, r] as const));
    for (const slot of map.northWall) {
      if (slot.kind !== 'window') continue;
      const room = roomById.get(slot.roomId);
      if (!room) continue;
      const cx = (slot.x + slot.span / 2) * T;
      const cy = slot.y * T + T / 2;
      const region = input.regions.find((r) => cx >= r.rect.x && cx < r.rect.x + r.rect.w && cy >= r.rect.y && cy < r.rect.y + r.rect.h);
      const colours = region ? lightingColours(region.theme) : input.colours;
      const q = shaftFor(slot, room, sun, colours, T);
      if (q) shafts.push(q);
    }
  }

  const darkRegions = input.regions.length > 0 ? voidRects({ x: 0, y: 0, w: map.cols * T, h: map.rows * T }, input.regions.map((r) => r.rect)) : [];
  return { fill, lights, shafts, darkRegions };
}

export interface LightmapSize {
  width: number;
  height: number;
  /** World px per lightmap px: 2 (half) or 4 (quarter). */
  scale: 2 | 4;
  /** True when even quarter resolution exceeds `maxTextureSize` (or the inputs are invalid): use the flat overlay instead. */
  fallback: boolean;
}

/** RT size for a world of `world.w x world.h` px: `half`/`quarter` of it, stepping half to quarter when the texture would
 *  exceed `maxTextureSize`; still too big (or degenerate input) signals `fallback` and the dimensions are capped. */
export function lightmapSize(world: { w: number; h: number }, resolution: 'half' | 'quarter', maxTextureSize: number): LightmapSize {
  const max = Number.isFinite(maxTextureSize) && maxTextureSize >= 1 ? Math.floor(maxTextureSize) : 0;
  const ok = Number.isFinite(world.w) && Number.isFinite(world.h) && world.w > 0 && world.h > 0 && max > 0;
  const at = (s: 2 | 4): LightmapSize => ({ width: Math.min(Math.max(1, Math.ceil(world.w / s)), max), height: Math.min(Math.max(1, Math.ceil(world.h / s)), max), scale: s, fallback: false });
  if (!ok) return { width: 1, height: 1, scale: 4, fallback: true };
  let size = at(resolution === 'quarter' ? 4 : 2);
  if (Math.ceil(world.w / size.scale) > max || Math.ceil(world.h / size.scale) > max) size = at(4);
  if (Math.ceil(world.w / size.scale) > max || Math.ceil(world.h / size.scale) > max) size.fallback = true;
  return size;
}
