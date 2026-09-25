import type { OfficeStyle } from '@tagconn/shared';
import { MULTIVERSE_THEME_ID } from '@tagconn/shared';
import { guildTheme } from './guild';
import { modernTheme } from './modern';
import { riftTheme } from './rift';
import type { ThemeDefinition } from './types';

export type { Costume, Palette, ThemeDefinition } from './types';
export { modernTheme } from './modern';
export { guildTheme } from './guild';
export { riftTheme } from './rift';
export { themedBubble } from './verbs';
export { renderGeneratedMap, THEME_BASE_TEXTURE } from './renderTheme';
export type { ThemeRegion } from './renderTheme';
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

/**
 * Looks up a `ThemeDefinition` by `office.style` (or a layout's own `style` override), or by the
 * Multiverse's own `'rift'` (M8 8h) — never a user-selectable `OfficeStyle`, hence the separate
 * check rather than a `THEMES['rift']` entry.
 */
export function getTheme(style: OfficeStyle | typeof MULTIVERSE_THEME_ID): ThemeDefinition {
  return style === MULTIVERSE_THEME_ID ? riftTheme : THEMES[style];
}
