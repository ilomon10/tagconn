// apps/web/src/game/postfx/uniforms.ts  (M8 8o: settings -> resolved shader config; M9: screen effects + pixel vignette)
import type { OfficeStyle, ScreenEffect, Settings } from '@tagconn/shared';
import { MULTIVERSE_THEME_ID } from '@tagconn/shared';
import { gradingForStyle } from './grading';
import { maxLightsForQuality } from './quality';
import type { ResolvedShaderConfig, ShaderQuality } from './types';

export type ShaderSettings = Settings['office']['shaders'];

/** A per-browser display preference override for the monitor screen effect (`displayPrefsStore`) —
 *  `on: false` forces it off regardless of `effect`; `undefined` (no override) falls back to
 *  `shaders.screen`/the legacy `scanlines` mapping below. */
export interface ScreenOverride {
  on: boolean;
  effect: Exclude<ScreenEffect, 'off'>;
}

/**
 * `office.shaders.screen`'s resolution order (docs/decisions.md #25): `shaders.enabled = false`
 * always wins (everything off); then a per-browser override, if any; then the settings default,
 * with the legacy `scanlines` flag kept working exactly as before (`scanlines && style === 'modern'`
 * maps to `'crt'` only when `screen` itself is still `'off'`, so an explicit `screen` setting always
 * wins over the old flag).
 */
function resolveScreenMode(shaders: ShaderSettings, style: OfficeStyle | typeof MULTIVERSE_THEME_ID, override?: ScreenOverride): ScreenEffect {
  if (!shaders.enabled) return 'off';
  if (override) return override.on ? override.effect : 'off';
  if (shaders.screen !== 'off') return shaders.screen;
  if (shaders.scanlines && style === 'modern') return 'crt';
  return 'off';
}

/**
 * Folds `office.shaders` + the active style + the already-resolved (never `'auto'`) quality tier
 * (+ an optional per-browser screen-effect override) into one `ResolvedShaderConfig` — everything
 * downstream (`PostFxController`, `LightLayer`) reads from this instead of re-deriving flags from
 * raw settings, so "shaders disabled" is a single short-circuit rather than scattered checks.
 */
export function resolveShaderConfig(
  shaders: ShaderSettings,
  style: OfficeStyle | typeof MULTIVERSE_THEME_ID,
  quality: ShaderQuality,
  screenOverride?: ScreenOverride,
): ResolvedShaderConfig {
  const enabled = shaders.enabled;
  return {
    enabled,
    quality,
    grading: enabled && shaders.grading ? gradingForStyle(style) : null,
    vignette: {
      strength: enabled ? shaders.vignette : 0,
      style: shaders.vignetteStyle,
      steps: shaders.vignetteSteps,
      pixel: shaders.vignettePixel,
      size: shaders.vignetteSize,
    },
    bloomStrength: enabled && shaders.lightGlow ? shaders.bloom : 0,
    lightGlow: enabled && shaders.lightGlow,
    screen: {
      mode: resolveScreenMode(shaders, style, screenOverride),
      strength: enabled ? shaders.screenStrength : 0,
    },
    maxLights: maxLightsForQuality(quality),
  };
}
