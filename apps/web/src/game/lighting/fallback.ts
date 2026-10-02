// M16: the flat sun-driven overlay used on canvas / low quality / lightmap off (docs/design/lighting.md section 2.4).
import type { ThemeDefinition } from '../themes/types';
import type { SunState } from './types';

export interface OverlayPlan {
  color: number;
  alpha: number;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0);
const mixColour = (a: number, b: number, t: number): number => {
  const ch = (s: number): number => Math.round(((a >> s) & 0xff) * (1 - t) + ((b >> s) & 0xff) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

/**
 * The M8 night rectangle driven by the sun: `alpha = nightAlpha * (1 - sun.ambient)` (0 by day, `nightAlpha` at `nightAmbient = 0`).
 * Colour is the theme's `nightTint`, drifting 30% toward the sun tint only as daylight returns (dawn/dusk warmth); at full night it
 * is exactly today's `nightTint`.
 */
export function overlayPlan(sun: SunState, theme: Pick<ThemeDefinition, 'lighting'>): OverlayPlan {
  const { nightTint, nightAlpha } = theme.lighting;
  return {
    color: mixColour(nightTint, sun.tint, 0.3 * clamp01(sun.daylight)),
    alpha: clamp01(nightAlpha * (1 - clamp01(sun.ambient))),
  };
}
