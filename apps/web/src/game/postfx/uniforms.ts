// apps/web/src/game/postfx/uniforms.ts  (M8 8o: settings -> resolved shader config)
import type { OfficeStyle, Settings } from '@tagconn/shared';
import { MULTIVERSE_THEME_ID } from '@tagconn/shared';
import { gradingForStyle } from './grading';
import { maxLightsForQuality } from './quality';
import type { ResolvedShaderConfig, ShaderQuality } from './types';

export type ShaderSettings = Settings['office']['shaders'];

/**
 * Folds `office.shaders` + the active style + the already-resolved (never `'auto'`) quality tier
 * into one `ResolvedShaderConfig` — everything downstream (`PostFxController`, `LightLayer`) reads
 * from this instead of re-deriving flags from raw settings, so "shaders disabled" is a single
 * short-circuit rather than scattered checks. Scanlines are modern-only per requirement 8o.1d.
 */
export function resolveShaderConfig(shaders: ShaderSettings, style: OfficeStyle | typeof MULTIVERSE_THEME_ID, quality: ShaderQuality): ResolvedShaderConfig {
  const enabled = shaders.enabled;
  return {
    enabled,
    quality,
    grading: enabled && shaders.grading ? gradingForStyle(style) : null,
    vignetteStrength: enabled ? shaders.vignette : 0,
    bloomStrength: enabled && shaders.lightGlow ? shaders.bloom : 0,
    lightGlow: enabled && shaders.lightGlow,
    scanlines: enabled && shaders.scanlines && style === 'modern',
    maxLights: maxLightsForQuality(quality),
  };
}
