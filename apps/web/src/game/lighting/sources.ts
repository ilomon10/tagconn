// M16 L2: the lights the lightmap draws (docs/design/lighting.md section 1.8). Pure.
import type { OfficeStyle } from '@tagconn/shared';
import type { MULTIVERSE_THEME_ID } from '@tagconn/shared';
import type { GeneratedMap } from '../procgen/types';
import type { ThemeDefinition } from '../themes/types';
import { extractLightSources } from '../postfx/lights';
import { nudgeIntoFloor } from './occluders';
import { lightingColours } from './palette';
import type { LightSourceKind, LightingQuality, LightmapLight, SunState } from './types';

export type { LightmapLight };

/** Cap on lights in one lightmap; the list is truncated from the end, so room lights (first) are never the ones dropped. */
export const LIGHTMAP_MAX_LIGHTS: Record<LightingQuality, number> = { high: 320, low: 96 };
/** No light reaches further than this, whatever `lightScale` says: bounds the visibility sweep and the ring size. */
export const MAX_LIGHT_REACH_TILES = 8;

/** Reach in tiles per kind (before `lightScale`); room lights bring their own `reachTiles`. Own-property guarded lookup. */
const REACH_TILES: Record<LightSourceKind, number> = { wall: 4, window: 3, point: 3, tiny: 1, 'ambient-fill': 3 };
/** Strength at full night per kind. */
const STRENGTH: Record<LightSourceKind, number> = { wall: 0.95, window: 1, point: 0.9, tiny: 0.35, 'ambient-fill': 0.75 };
const FIRE_REACH_TILES = 5;
/** `extractLightSources` gives a fireplace's flame a bloom radius of 14; lamps and screens get 7-8. */
const FIRE_BLOOM_RADIUS = 14;
/** A `window` slot's bloom radius is 9 at span 1, +5 per extra tile: reach grows by half a tile per tile of span. */
const WINDOW_BASE_RADIUS = 9;

const own = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

/** Full reach in px for `tiles` tiles at `lightScale`, clamped to `MAX_LIGHT_REACH_TILES` (non-finite or non-positive: 0). */
export function clampReach(tiles: number, lightScale: number, T: number): number {
  const r = tiles * lightScale;
  if (!Number.isFinite(r) || !(r > 0)) return 0;
  return Math.min(r, MAX_LIGHT_REACH_TILES) * T;
}

/** Strength 0..1 of `light` under `sun`: electric lights fade by day (`1 - 0.85 * daylight`), windows follow the sun
 *  (`daylight`, plus `0.25 * moon` for moonlight). Unknown kinds give 0. */
export function intensityAt(light: Pick<LightmapLight, 'kind'>, sun: Pick<SunState, 'daylight' | 'moon'>): number {
  if (!own(STRENGTH, light.kind)) return 0;
  const v = light.kind === 'window' ? sun.daylight + 0.25 * sun.moon : 1 - 0.85 * sun.daylight;
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

/**
 * Room lights first (they shape the rooms), then `extractLightSources(map, style, -1)` mapped 1:1 (uncapped), truncated to
 * `LIGHTMAP_MAX_LIGHTS[quality]` BEFORE any visibility work. Wall and window lights sit on a wall face and are nudged onto
 * the floor side so they light their room.
 */
export function lightmapSources(
  map: GeneratedMap,
  style: OfficeStyle | typeof MULTIVERSE_THEME_ID,
  regionThemeAt: (x: number, y: number) => Pick<ThemeDefinition, 'id' | 'lighting'>,
  lightScale: number,
  quality: LightingQuality = 'high',
): LightmapLight[] {
  const T = map.tileSize;
  const out: LightmapLight[] = [];

  for (const l of map.lights ?? []) {
    const x = (l.x + 0.5) * T;
    const y = (l.y + 0.5) * T;
    const reach = clampReach(l.reachTiles, lightScale, T);
    if (!(reach > 0) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({ x, y, kind: 'ambient-fill', color: lightingColours(regionThemeAt(x, y)).roomLight, reach, strength: STRENGTH['ambient-fill'], flicker: false, roomId: l.roomId });
  }

  for (const s of extractLightSources(map, style, -1)) {
    if (!own(REACH_TILES, s.kind)) continue;
    let tiles = REACH_TILES[s.kind];
    if (s.kind === 'point' && s.radius >= FIRE_BLOOM_RADIUS) tiles = FIRE_REACH_TILES;
    if (s.kind === 'window') tiles += Math.max(0, (s.radius - WINDOW_BASE_RADIUS) / 10);
    const reach = clampReach(tiles, lightScale, T);
    if (!(reach > 0)) continue;
    const p = s.kind === 'wall' || s.kind === 'window' ? nudgeIntoFloor(map.tiles, T, s) : s;
    out.push({ x: p.x, y: p.y, kind: s.kind, color: s.color, reach, strength: STRENGTH[s.kind], flicker: s.flicker, roomId: map.roomAt[Math.floor(p.y / T)]?.[Math.floor(p.x / T)] ?? null });
  }

  return out.slice(0, LIGHTMAP_MAX_LIGHTS[quality]);
}
