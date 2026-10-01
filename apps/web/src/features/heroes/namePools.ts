import { HERO_DEFAULT_POOL_KEY, HERO_LIMITS, type HeroNamePools } from '@tagconn/shared';

/**
 * Pure helpers for the Name pools tab (docs/design/living-office.md section 3.4): "one textarea per
 * role (one name per line) plus `default`", with inline validation before it's saved as
 * `settings.heroes.namePools` (a wholesale-replace setting — `WHOLESALE_REPLACE_SETTINGS`).
 */

/** One name per line, blank lines dropped, each trimmed (mirrors `HeroNameSchema`'s own trim). */
export function parsePoolText(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True when the raw textarea `text` already parses to `names`, so it must not be overwritten from
 *  props (that would eat a trailing space or newline the user just typed). */
export const poolTextInSync = (text: string, names: readonly string[]): boolean => parsePoolText(text).join('\n') === names.join('\n');

/** The textarea's starting text for one role's pool (own-property only — unlike `namePoolFor`, this
 *  editor shows each role's own list, not the `default` fallback, so an empty pool reads as empty). */
export function poolText(pools: HeroNamePools, role: string): string {
  return (Object.prototype.hasOwnProperty.call(pools, role) ? pools[role] : undefined)?.join('\n') ?? '';
}

/** The map to compare/save: roles whose pool is empty are dropped, so `namePoolFor` falls back to
 *  `default` instead of yielding no names. The editor keeps `[]` entries while a textarea is being
 *  edited (an emptied box must not make the role vanish mid-edit); they are only dropped here. */
export function normalizePoolsForSave(pools: HeroNamePools): HeroNamePools {
  return Object.fromEntries(Object.entries(pools).filter(([, names]) => names.length > 0));
}

/** Role keys to render a textarea for: every known role plus any role already present in the stored
 *  pools (so a renamed/removed role's names aren't silently dropped), `default` always last. */
export function rolesForNamePools(roleNames: readonly string[], pools: HeroNamePools): string[] {
  const set = new Set<string>([...roleNames, ...Object.keys(pools)]);
  set.delete(HERO_DEFAULT_POOL_KEY);
  return [...set].sort((a, b) => a.localeCompare(b)).concat(HERO_DEFAULT_POOL_KEY);
}

export interface NamePoolIssue {
  role: string;
  message: string;
}

/** Inline validation (docs/design/living-office.md section 3.4: "length, max 200, duplicates
 *  flagged"). Doesn't reject — the caller decides whether to still allow saving with warnings. */
export function validateNamePools(pools: HeroNamePools): NamePoolIssue[] {
  const issues: NamePoolIssue[] = [];
  for (const [role, names] of Object.entries(pools)) {
    if (names.length > HERO_LIMITS.maxPoolNames) issues.push({ role, message: `At most ${HERO_LIMITS.maxPoolNames} names allowed (has ${names.length}).` });

    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const n of names) {
      const key = n.toLowerCase();
      if (seen.has(key)) dupes.add(n);
      seen.add(key);
    }
    if (dupes.size > 0) issues.push({ role, message: `Duplicate name(s): ${[...dupes].join(', ')}.` });

    const tooLong = names.filter((n) => n.length > HERO_LIMITS.maxNameLength);
    if (tooLong.length > 0) issues.push({ role, message: `Too long (max ${HERO_LIMITS.maxNameLength} characters): ${tooLong.join(', ')}.` });
  }
  return issues;
}
