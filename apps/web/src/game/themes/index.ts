import type { OfficeStyle } from '@tagconn/shared';
import { guildTheme } from './guild';
import { modernTheme } from './modern';
import type { ThemeDefinition } from './types';

export type { Costume, Palette, ThemeDefinition } from './types';
export { modernTheme } from './modern';
export { guildTheme } from './guild';
export { themedBubble } from './verbs';
export { renderGeneratedMap, THEME_BASE_TEXTURE } from './renderTheme';
export {
  CLOAK_TEXTURE,
  GOGGLES_TEXTURE,
  hatTextureKey,
  paintCostumeTextures,
  staffTextureKey,
} from './costumes';
export {
  ambientMotes,
  channelAura,
  createActivityFx,
  ensureFxTextures,
  portalShimmer,
  potionBubbles,
  prefersReducedMotion,
  runeGlow,
  sparkles,
  torchFlicker,
} from './fx';

const THEMES: Record<OfficeStyle, ThemeDefinition> = {
  modern: modernTheme,
  guild: guildTheme,
};

/** Looks up a `ThemeDefinition` by `office.style` (or a layout's own `style` override). */
export function getTheme(style: OfficeStyle): ThemeDefinition {
  return THEMES[style];
}
