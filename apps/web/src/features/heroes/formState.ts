import {
  HERO_ACCESSORIES,
  HERO_HAIR_COLORS,
  HERO_HAIR_STYLE_COUNT,
  HERO_HATS,
  HERO_LIMITS,
  HERO_LOOK_STYLES,
  HERO_PROPS,
  HERO_SKIN_TONES,
  heroLookForStyle,
  type Agent,
  type Hero,
  type HeroAppearance,
  type HeroLookStyle,
  type HeroPatch,
  type HeroStyleOverride,
  type Project,
} from '@tagconn/shared';
import { resolveTitle } from '../../game/lookResolver';
import type { ThemeDefinition } from '../../game/themes';
import { floorsInOrder, isMultiverseFloor, type FloorOrder } from '../../lib/floors';
import { mulberry32, pick } from '../../game/procgen/rng';
import { ALL_FLOORS } from '../../stores/officeStore';

/**
 * Pure helpers backing the hero editor (docs/design/living-office.md section 3.4): the edit pane's
 * draft/diff/validation, the seeded randomizer, list grouping and status, and which floor the panel
 * opens on. Kept side-effect free so they're testable without React or a socket (`formState.test.ts`).
 */

// ------------------------------------------------------------------------------------- draft/diff

/** Per-style overrides being edited. A missing key / missing field means "use base". */
export type StyleDrafts = Partial<Record<HeroLookStyle, HeroStyleOverride>>;

/** Editable form state for one hero. `title` is the raw text field (`''` = "use the themed default"). */
export interface HeroDraft {
  /** Role key; changing it moves the hero (server: only while released, lowest free slot of the new role). */
  role: string;
  name: string;
  title: string;
  appearance: HeroAppearance;
  styles: StyleDrafts;
}

const APPEARANCE_KEYS = ['skin', 'hairStyle', 'hairColor', 'outfitColor', 'hat', 'hatColor', 'prop', 'accessory', 'accessoryColor'] as const satisfies readonly (keyof HeroAppearance)[];
export const OVERRIDE_KEYS = [...APPEARANCE_KEYS, 'title'] as const satisfies readonly (keyof HeroStyleOverride)[];

/** Copy of an override without `undefined` fields; `undefined` when nothing is left. */
export function cleanOverride(o: HeroStyleOverride | undefined): HeroStyleOverride | undefined {
  if (!o) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of OVERRIDE_KEYS) if (o[k] !== undefined) out[k] = o[k];
  return Object.keys(out).length > 0 ? (out as HeroStyleOverride) : undefined;
}

/** `styles` with `style`'s override replaced (or removed when `override` is empty/undefined). */
export function withStyleOverride(styles: StyleDrafts, style: HeroLookStyle, override: HeroStyleOverride | undefined): StyleDrafts {
  const { [style]: _old, ...rest } = styles;
  const clean = cleanOverride(override);
  return clean ? { ...rest, [style]: clean } : rest;
}

export function draftFromHero(h: Hero): HeroDraft {
  let styles: StyleDrafts = {};
  for (const s of HERO_LOOK_STYLES) styles = withStyleOverride(styles, s, h.styles?.[s]);
  return { role: h.role, name: h.name, title: h.title ?? '', appearance: h.appearance, styles };
}

/**
 * Minimal patch turning `hero` into `draft`, or `null` if nothing changed. Always carries
 * `baseUpdatedAt` when non-null (the 409 check — docs/design/living-office.md section 3.4 "Save"),
 * unless `force` (conflict "Overwrite": every field is sent, no concurrency check).
 *
 * A changed style is sent as its full override (the server replaces it wholesale), or `null` when
 * the draft has no fields left for it.
 */
export function diffHeroPatch(hero: Hero, draft: HeroDraft, force = false): HeroPatch | null {
  const patch: HeroPatch = {};
  let changed = false;

  if (draft.role !== hero.role) {
    patch.role = draft.role;
    changed = true;
  }

  const name = draft.name.trim();
  if (force || name !== hero.name) {
    patch.name = name;
    changed = changed || name !== hero.name;
  }

  const title = draft.title.trim() === '' ? null : draft.title.trim();
  if (force || title !== hero.title) {
    patch.title = title;
    changed = changed || title !== hero.title;
  }

  const appearance: Partial<HeroAppearance> = {};
  for (const k of APPEARANCE_KEYS) {
    if (force || draft.appearance[k] !== hero.appearance[k]) {
      (appearance as Record<string, unknown>)[k] = draft.appearance[k];
      changed = changed || draft.appearance[k] !== hero.appearance[k];
    }
  }
  if (Object.keys(appearance).length > 0) patch.appearance = appearance;

  const styles: NonNullable<HeroPatch['styles']> = {};
  for (const s of HERO_LOOK_STYLES) {
    const before = cleanOverride(hero.styles?.[s]);
    const raw = draft.styles[s];
    // The title is raw text while typing; blank means null (the themed default).
    const after = cleanOverride(raw && typeof raw.title === 'string' ? { ...raw, title: raw.title.trim() || null } : raw);
    if (!before && !after) continue;
    // The server replaces a style's override wholesale: send the full draft override, or null when empty.
    const same = before && after && OVERRIDE_KEYS.every((k) => before[k] === after[k]);
    if (same && !force) continue;
    styles[s] = after ?? null;
    changed = changed || !same;
  }
  if (Object.keys(styles).length > 0) patch.styles = styles;

  if (!changed) return null;
  if (!force) patch.baseUpdatedAt = hero.updatedAt;
  return patch;
}

/** The look a style tab previews: base appearance with that style's overrides on top. */
export function draftLookForStyle(draft: HeroDraft, style: HeroLookStyle): { appearance: HeroAppearance; title: string | null } {
  return heroLookForStyle({ appearance: draft.appearance, title: draft.title.trim() === '' ? null : draft.title.trim(), styles: draft.styles }, style);
}

// ------------------------------------------------------------------------------------ validation

/** `null` = valid. Mirrors `HeroNameSchema` (trim, 1..maxNameLength after trimming). */
export function validateHeroName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Name is required.';
  if (trimmed.length > HERO_LIMITS.maxNameLength) return `Name must be at most ${HERO_LIMITS.maxNameLength} characters.`;
  return null;
}

/** `null` = valid. An empty title is always valid (it means "use the themed default"). */
export function validateHeroTitle(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > HERO_LIMITS.maxTitleLength) return `Title must be at most ${HERO_LIMITS.maxTitleLength} characters.`;
  return null;
}

// ------------------------------------------------------------------------------------ randomize

/**
 * Randomize (docs/design/living-office.md section 3.4): reseeds skin, hair style and hair colour
 * from the curated palettes. `includeCostume` (Shift held) also reseeds hat/prop/accessory — name,
 * title and (without Shift) the costume stay untouched. `seed` is caller-supplied (`Date.now()` in
 * the editor) so the result is deterministic and testable.
 */
export function randomizeAppearance(current: HeroAppearance, seed: number, includeCostume: boolean): HeroAppearance {
  const rand = mulberry32(seed);
  const next: HeroAppearance = {
    ...current,
    skin: pick(rand, HERO_SKIN_TONES),
    hairStyle: Math.floor(rand() * HERO_HAIR_STYLE_COUNT) % HERO_HAIR_STYLE_COUNT,
    hairColor: pick(rand, HERO_HAIR_COLORS),
  };
  if (includeCostume) {
    next.hat = pick(rand, HERO_HATS);
    next.prop = pick(rand, HERO_PROPS);
    next.accessory = pick(rand, HERO_ACCESSORIES);
  }
  return next;
}

// --------------------------------------------------------------------------------------- status

export type HeroStatus =
  | { kind: 'on-quest'; agentId: string; description?: string }
  | { kind: 'resting' }
  | { kind: 'away' };

/** A hero's status for the roster row (docs/design/living-office.md section 3.4): "on quest" while
 *  bound to a live agent (with its description if known), "resting" once released but previously
 *  bound, or "away" for a freshly recruited hero that has never been bound. */
export function heroStatus(hero: Pick<Hero, 'boundAgentId' | 'releasedAt'>, agents: Record<string, Pick<Agent, 'description'>>): HeroStatus {
  if (hero.boundAgentId === null) return { kind: 'away' };
  if (hero.releasedAt !== null) return { kind: 'resting' };
  return { kind: 'on-quest', agentId: hero.boundAgentId, description: agents[hero.boundAgentId]?.description };
}

// ------------------------------------------------------------------------------------- grouping

export interface HeroRoleGroup {
  role: string;
  title: string;
  heroes: Hero[];
}

/** Groups heroes by role, in themed role-title order (docs/design/living-office.md section 3.4). */
export function groupHeroesByRole(heroes: readonly Hero[], theme: Pick<ThemeDefinition, 'roleTitles'>, fallbackTitle: (role: string) => string): HeroRoleGroup[] {
  const byRole = new Map<string, Hero[]>();
  for (const h of heroes) {
    const list = byRole.get(h.role);
    if (list) list.push(h);
    else byRole.set(h.role, [h]);
  }
  const groups = [...byRole.entries()].map(([role, list]) => ({
    role,
    title: resolveTitle(theme, role, fallbackTitle(role)),
    heroes: [...list].sort((a, b) => a.slot - b.slot),
  }));
  groups.sort((a, b) => a.title.localeCompare(b.title));
  return groups;
}

// --------------------------------------------------------------------------------- default floor

/** The floor the hero panel should open on: the current selection if it's a real (non-Multiverse)
 *  floor, else the first real floor in stairs order — heroes are always edited for one concrete
 *  project, never for the Multiverse (`floorsInOrder` always appends it last; it's filtered out
 *  here since it isn't a real project to recruit or bind heroes for). */
export function defaultHeroFloor(projects: Record<string, Project>, selectedProjectId: string, floorOrder: FloorOrder): string | undefined {
  if (selectedProjectId !== ALL_FLOORS && Object.hasOwn(projects, selectedProjectId)) return selectedProjectId;
  return floorsInOrder(Object.values(projects), floorOrder).find((p) => !isMultiverseFloor(p.id))?.id;
}
