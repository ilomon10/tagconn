import { SHIPPED_ROLE_TITLES } from './themes/shippedTitles';
import type { Costume, ThemeDefinition } from './themes/types';

/**
 * Pure lookups that turn an agent's role into what a theme draws for it: the name-tag title
 * (docs/design/guild-hall.md section 3 "Guild title") and the costume (hat/cloak/staff/goggles).
 * Kept separate from `actors/Character.ts` so they're testable without a Phaser runtime.
 */

/**
 * Title shown for `roleName` under `theme` (M12). Precedence:
 * 1. a hero's own title (per-style override already applied by `heroLookForStyle`);
 * 2. the user's role title when they EDITED it (it differs from the shipped default);
 * 3. the theme's title for the role (guild: "Guild Master");
 * 4. the role's title (`fallbackTitle`), then the raw role name.
 */
export function titleFor(
  theme: Pick<ThemeDefinition, 'roleTitles'>,
  roleName: string,
  roleTitle: string | undefined,
  heroTitle?: string | null,
): string {
  if (heroTitle) return heroTitle;
  const shipped = SHIPPED_ROLE_TITLES[roleName];
  const edited = roleTitle !== undefined && roleTitle !== shipped;
  if (edited && roleTitle) return roleTitle;
  return theme.roleTitles[roleName] ?? roleTitle ?? roleName;
}

/** Themed title for `roleName` without a hero (see `titleFor`). */
export function resolveTitle(theme: Pick<ThemeDefinition, 'roleTitles'>, roleName: string, fallbackTitle: string): string {
  return titleFor(theme, roleName, fallbackTitle);
}

/** Themed costume for `roleName` (falls back to the theme's `default` entry, then nothing). */
export function resolveCostume(theme: Pick<ThemeDefinition, 'costumes'>, roleName: string): Costume {
  return theme.costumes[roleName] ?? theme.costumes.default ?? {};
}
