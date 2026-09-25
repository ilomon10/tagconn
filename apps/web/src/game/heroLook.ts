import type { HeroAppearance } from '@tagconn/shared';
import { hexToNumber, HAIR_STYLES } from './textures';
import type { Costume } from './themes/types';

/**
 * Resolves a hero's stored appearance (`packages/shared/src/heroes.ts` `HeroAppearance`) plus the
 * active theme's per-role costume (`lookResolver.ts`'s `resolveCostume`) into the concrete draw
 * parameters `Character` needs: skin/hair tints, the hair bitmap index, the outfit (body) tint, and
 * the final `Costume` to hand to `Character.setCostume`.
 *
 * `hat`/`prop`/`accessory` on `HeroAppearance` are the only fields with `auto`/`none` semantics
 * (docs/design/living-office.md section 3, `HERO_HATS`/`HERO_PROPS`/`HERO_ACCESSORIES`):
 * - `auto` keeps whatever the theme's costume gives the role (nothing under `modern`, since its
 *   costumes are all `{}`).
 * - `none` omits the field regardless of what the theme gives.
 * - any other value is an explicit hero override.
 *
 * Every other field on `HeroAppearance` (skin, hair style/colour, and the nullable colour
 * overrides) is already a concrete value — `generateHeroAppearance(seed)` (shared) is what does
 * the seeded randomization, so this function itself is a plain, deterministic mapping: the same
 * three inputs always resolve to the same output.
 */
export interface ResolvedHeroCostume {
  /** The final costume — hat/staff/cloak/goggles resolved, `robe` set to the outfit tint below. */
  costume: Costume;
  /** Skin tint for `head`/`handL`/`handR`. */
  skin: number;
  /** Hair tint for the `ch-hair-<hairStyle>` texture. */
  hair: number;
  /** Which `ch-hair-<n>` bitmap to use (0..`HAIR_STYLES - 1`). */
  hairStyle: number;
  /** Outfit (body) tint — also `costume.robe`. */
  outfit: number;
}

export function resolveHeroCostume(themeCostume: Costume, a: HeroAppearance, roleColor: number): ResolvedHeroCostume {
  // null = "the role colour" (schema comment): keep whatever the theme paints for this role by
  // default (its own robe tint, e.g. the guild theme's per-role colours) rather than flattening
  // every hero of a role to the same `roleColor` used for badges/name tags.
  const outfit = a.outfitColor !== null ? hexToNumber(a.outfitColor) : (themeCostume.robe ?? roleColor);

  let hat: Costume['hat'];
  if (a.hat === 'none') hat = 'none';
  else if (a.hat === 'auto') hat = themeCostume.hat ?? 'none';
  else hat = a.hat;
  // null = "the theme's hat colour for the role, else the outfit colour" (schema comment).
  const hatColor = hat !== 'none' ? (a.hatColor !== null ? hexToNumber(a.hatColor) : (themeCostume.hatColor ?? outfit)) : undefined;

  let staff: Costume['staff'];
  if (a.prop === 'none') staff = 'none';
  else if (a.prop === 'auto') staff = themeCostume.staff ?? 'none';
  else staff = a.prop;

  let cloak: number | undefined;
  let goggles: boolean | undefined;
  if (a.accessory === 'auto') {
    cloak = themeCostume.cloak;
    goggles = themeCostume.goggles;
  } else if (a.accessory === 'goggles') {
    goggles = true;
  } else if (a.accessory === 'cloak') {
    // null = "the theme's cloak colour, else the role colour" (schema comment) — note this falls
    // back to the plain `roleColor`, not `outfit`, unlike `hatColor` above.
    cloak = a.accessoryColor !== null ? hexToNumber(a.accessoryColor) : (themeCostume.cloak ?? roleColor);
  }
  // a.accessory === 'none': cloak and goggles both stay undefined/falsy.

  const costume: Costume = {
    robe: outfit,
    hat,
    ...(hatColor !== undefined ? { hatColor } : {}),
    staff,
    ...(cloak !== undefined ? { cloak } : {}),
    ...(goggles !== undefined ? { goggles } : {}),
    ...(themeCostume.trim !== undefined ? { trim: themeCostume.trim } : {}),
  };

  return {
    costume,
    skin: hexToNumber(a.skin),
    hair: hexToNumber(a.hairColor),
    hairStyle: ((a.hairStyle % HAIR_STYLES) + HAIR_STYLES) % HAIR_STYLES,
    outfit,
  };
}
