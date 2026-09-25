import type { Costume, ThemeDefinition } from './themes/types';

/**
 * Pure lookups that turn an agent's role into what a theme draws for it: the name-tag title
 * (docs/design/guild-hall.md section 3 "Guild title") and the costume (hat/cloak/staff/goggles).
 * Kept separate from `actors/Character.ts` so they're testable without a Phaser runtime.
 */

/** Themed title for `roleName` (falls back to the role's own title, then the raw role name). */
export function resolveTitle(theme: Pick<ThemeDefinition, 'roleTitles'>, roleName: string, fallbackTitle: string): string {
  return theme.roleTitles[roleName] ?? fallbackTitle;
}

/** Themed costume for `roleName` (falls back to the theme's `default` entry, then nothing). */
export function resolveCostume(theme: Pick<ThemeDefinition, 'costumes'>, roleName: string): Costume {
  return theme.costumes[roleName] ?? theme.costumes.default ?? {};
}
