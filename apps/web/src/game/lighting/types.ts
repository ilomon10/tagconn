// apps/web/src/game/lighting/types.ts  (M16 W0-L: type-only, no runtime code, no Phaser)
//
// Shared shapes of the lighting modules (docs/design/lighting.md sections 1.8, 2.2-2.6). L1 (clock/sun/fallback/palette),
// L2 (occluders/visibility/sources/plan/shadows) and L4 (Phaser layers) all code against this file.
import type { LightSourceKind } from '../postfx/types';
import type { Point, Rect } from '../procgen/types';

export type { LightSourceKind };

/** Which render path is active; `low` = quarter-res, fewer bands (docs/design/lighting.md section 3). */
export type LightingQuality = 'low' | 'high';

export type SunPhase = 'night' | 'dawn' | 'day' | 'dusk';

export interface SunState {
  /** Decimal hour, [0, 24). */
  hour: number;
  phase: SunPhase;
  /** 0 at night, 1 in full day; smoothstep ramps `twilightHours` wide centred on dawn/dusk. */
  daylight: number;
  /** 0..1: sin of the day fraction (0 at dawn/dusk centres, 1 at solar noon); 0 at night. */
  elevation: number;
  /** -1 (morning, sun east) .. +1 (evening, sun west); 0 at noon. Shafts and day shadows lean by `-skew`. */
  skew: number;
  /** 0..1 moonlight: `1 - daylight`, times a slow 29.5-day phase factor in [0.4, 1] from the host date. */
  moon: number;
  /** Ambient brightness for the lightmap fill: `nightAmbient + (1 - nightAmbient) * daylight`. */
  ambient: number;
  /** Ambient colour: mix(moonTint, white, daylight) warmed by dawnTint/duskTint inside the ramps. */
  tint: number;
}

/** Axis-aligned occluder edge, world px. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Polygon = Point[];

/** A light as the lightmap sees it (built by `lighting/sources.ts#lightmapSources`). */
export interface LightmapLight {
  /** World px. */
  x: number;
  y: number;
  kind: LightSourceKind;
  color: number;
  /** Full reach in world px (already scaled by `lightScale`): room lights `reachTiles * T`, wall lights 4 T, lamps 3 T, fireplace 5 T, windows 3 T, tiny 1 T. */
  reach: number;
  /** 0..1 at full night; `intensityAt(sun)` fades electric lights by day (`1 - 0.85 * sun.daylight`) and keeps windows (`sun.daylight`, moonlight `0.25 * sun.moon`). */
  strength: number;
  flicker: boolean;
  roomId: string | null;
}

/** Concentric rings, outer to inner. */
export interface GradientBand {
  r: number;
  alpha: number;
}

export interface PlannedLight {
  light: LightmapLight;
  /** Visibility polygon at full reach (cached per map; `plan` only re-reads it). */
  polygon: Point[];
  bands: GradientBand[];
  /** From `intensityAt(light, sun)`. */
  intensity: number;
}

export interface ShaftQuad {
  points: [Point, Point, Point, Point];
  color: number;
  alpha: number;
  roomId: string;
}

export interface LightmapPlan {
  /** RT fill: `sun.tint` scaled to `sun.ambient` (the multiply base). */
  fill: { color: number };
  lights: PlannedLight[];
  shafts: ShaftQuad[];
  /** Realm rects whose fill differs (Multiverse: the rift void between realms stays dark). */
  darkRegions: Rect[];
}

export interface ShadowQuad {
  points: [Point, Point, Point, Point];
  alpha: number;
}

export interface CastShadow {
  dx: number;
  dy: number;
  /** Px (6..14). */
  len: number;
  alpha: number;
}
