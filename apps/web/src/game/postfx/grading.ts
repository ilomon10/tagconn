// apps/web/src/game/postfx/grading.ts  (M8 8o.1a: per-style color grading presets)
import type { OfficeStyle } from '@tagconn/shared';
import { MULTIVERSE_THEME_ID } from '@tagconn/shared';
import type { GradingPreset } from './types';

/** modern: cozy, warm office — slightly desaturated with lifted, neutral-warm shadows. */
const MODERN: GradingPreset = {
  lift: [0.012, 0.008, 0.0],
  gamma: [1.0, 1.0, 1.04],
  gain: [1.05, 1.02, 0.95],
  saturation: 0.88,
  warmth: 0.16,
};

/** guild: candlelit amber highlights over deep blue shadows (the tavern/castle-hall references). */
const GUILD: GradingPreset = {
  lift: [-0.01, 0.0, 0.03],
  gamma: [1.02, 1.0, 0.98],
  gain: [1.12, 0.98, 0.82],
  saturation: 1.08,
  warmth: 0.26,
};

/** rift (Multiverse): cool aurora teal/violet, deepened shadows, richer saturation. */
const RIFT: GradingPreset = {
  lift: [0.0, 0.01, 0.03],
  gamma: [0.98, 1.0, 1.02],
  gain: [0.88, 1.02, 1.12],
  saturation: 1.12,
  warmth: -0.2,
};

const PRESETS: Record<OfficeStyle, GradingPreset> = {
  modern: MODERN,
  guild: GUILD,
};

/** The no-op grade: `PostFxController` swaps this in when `office.shaders.grading` is off (or
 *  shaders are disabled entirely) instead of adding/removing the pipeline — see its header note. */
export const IDENTITY_GRADING: GradingPreset = {
  lift: [0, 0, 0],
  gamma: [1, 1, 1],
  gain: [1, 1, 1],
  saturation: 1,
  warmth: 0,
};

/** Looks up the grading preset for a style, mirroring `themes/index.ts#getTheme`'s own
 *  style-or-rift dispatch (the Multiverse's `'rift'` is never a user-selectable `OfficeStyle`). */
export function gradingForStyle(style: OfficeStyle | typeof MULTIVERSE_THEME_ID): GradingPreset {
  return style === MULTIVERSE_THEME_ID ? RIFT : PRESETS[style];
}
