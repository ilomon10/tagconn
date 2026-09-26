// apps/web/src/game/postfx/types.ts  (M8 8o: WebGL shaders / post-processing)
//
// Pure types shared by the postfx logic modules (grading.ts, lights.ts, quality.ts, uniforms.ts)
// and the Phaser-facing pieces (GradingPipeline.ts, ScanlinesPipeline.ts, LightLayer.ts,
// PostFxController.ts). Kept dependency-free (no Phaser import, runtime or type) so the logic
// modules stay importable from vitest's node environment without touching `window`.

/** Resolved (never `'auto'`) render quality — `PostFxController` resolves `'auto'` down to one of
 *  these via `quality.ts` before anything here is consulted. */
export type ShaderQuality = 'low' | 'high';

/** Per-channel lift/gamma/gain color grade plus overall saturation and a warm<->cool tilt, in the
 *  same spirit as a film-grade LUT but cheap enough to run as a few `vec3` ops per pixel (no LUT
 *  texture, hence "LUT-less" — requirement 8o.1a). */
export interface GradingPreset {
  /** Raises (or crushes) blacks per channel; 0 = no lift. */
  lift: readonly [r: number, g: number, b: number];
  /** Midtone response per channel (`pow(color, 1/gamma)`); 1 = no change. */
  gamma: readonly [r: number, g: number, b: number];
  /** Scales highlights per channel; 1 = no change. */
  gain: readonly [r: number, g: number, b: number];
  /** 1 = unchanged, 0 = grayscale, >1 = more saturated. */
  saturation: number;
  /** -1..1: negative cools (pushes blue), positive warms (pushes red/amber). */
  warmth: number;
}

/** A light-emitting point pulled out of a `GeneratedMap` (torches, lanterns, desk lamps, glowing
 *  screens) that the bloom light layer draws a soft additive glow sprite at. World-space pixels,
 *  same coordinate space as everything else the scene draws in (`tile * tileSize`). */
export interface LightSource {
  x: number;
  y: number;
  /** Painter's-algorithm sort key — matches the convention every other ambient object in the
   *  themes use (`slot.y * tileSize`/`f.y * tileSize`), so the glow sits in its tile row. */
  depth: number;
  color: number;
  /** Glow sprite radius in world pixels before the shared texture's own scale is applied. */
  radius: number;
  /** Open flames flicker (torches/braziers); electric light sources (lamps, screens, lanterns)
   *  hold steady — flicker is skipped outright under reduced motion by the caller. */
  flicker: boolean;
}

/** Everything `PostFxController` needs for one frame, fully resolved from
 *  `Settings['office']['shaders']` + the active style + the resolved quality — see `uniforms.ts`. */
export interface ResolvedShaderConfig {
  enabled: boolean;
  quality: ShaderQuality;
  /** `null` when grading is off (or shaders are off entirely) — no pipeline should be attached. */
  grading: GradingPreset | null;
  /** 0 disables the vignette pipeline outright. */
  vignetteStrength: number;
  /** 0 disables the bloom pass on the light layer (plain additive sprites still draw, see 8o.1c). */
  bloomStrength: number;
  /** Whether the light layer's glow sprites exist at all. */
  lightGlow: boolean;
  /** CRT scanlines + mild curvature/chromatic offset — modern style only, per requirement 8o.1d. */
  scanlines: boolean;
  /** Cap on simultaneous light sprites; lower on `'low'` quality (requirement 8o.3). */
  maxLights: number;
}
