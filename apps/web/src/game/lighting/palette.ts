// M16: per-theme lighting colour defaults (docs/design/lighting.md section 1.6). A theme's optional fields win; the rest
// come from LIGHTING_DEFAULTS[theme.id], with an unknown id falling back to `modern`.
import type { ThemeDefinition } from '../themes/types';

export interface LightingColours {
  dayTint: number;
  nightTint: number;
  nightAlpha: number;
  glowAtNight: boolean;
  dawnTint: number;
  duskTint: number;
  moonTint: number;
  sunColor: number;
  moonColor: number;
  roomLight: number;
  shadowAlpha: number;
}

type OptionalColours = Pick<
  LightingColours,
  'dawnTint' | 'duskTint' | 'moonTint' | 'sunColor' | 'moonColor' | 'roomLight' | 'shadowAlpha'
>;

export const LIGHTING_DEFAULTS: Record<string, OptionalColours> = {
  modern: { dawnTint: 0xffd9b0, duskTint: 0xffb080, moonTint: 0x3a4a80, sunColor: 0xfff2c8, moonColor: 0x9ab0ff, roomLight: 0xfff4dc, shadowAlpha: 0.22 },
  guild: { dawnTint: 0xffc890, duskTint: 0xff9a60, moonTint: 0x4a3a80, sunColor: 0xffd89a, moonColor: 0xa090ff, roomLight: 0xffb060, shadowAlpha: 0.28 },
  rift: { dawnTint: 0xd0b0ff, duskTint: 0xb080ff, moonTint: 0x30206a, sunColor: 0xa8f0ff, moonColor: 0x7ef0e8, roomLight: 0x9fd8ff, shadowAlpha: 0.2 },
};

/** Fills the optional `theme.lighting` fields from the per-theme defaults. */
export function lightingColours(theme: Pick<ThemeDefinition, 'id' | 'lighting'>): LightingColours {
  const own = Object.prototype.hasOwnProperty.call(LIGHTING_DEFAULTS, theme.id);
  const d = (own ? LIGHTING_DEFAULTS[theme.id] : LIGHTING_DEFAULTS['modern']) as OptionalColours;
  const l = theme.lighting;
  return {
    dayTint: l.dayTint,
    nightTint: l.nightTint,
    nightAlpha: l.nightAlpha,
    glowAtNight: l.glowAtNight,
    dawnTint: l.dawnTint ?? d.dawnTint,
    duskTint: l.duskTint ?? d.duskTint,
    moonTint: l.moonTint ?? d.moonTint,
    sunColor: l.sunColor ?? d.sunColor,
    moonColor: l.moonColor ?? d.moonColor,
    roomLight: l.roomLight ?? d.roomLight,
    shadowAlpha: l.shadowAlpha ?? d.shadowAlpha,
  };
}
