// apps/web/src/game/nav/classes.ts  (M15, docs/design/navigation.md)
//
// Navigation classes: how many nav cells (per side) a body needs. A `person` is a SUB x SUB block,
// i.e. exactly one tile, so today's whole-tile routing is the k = 2 special case.
import type { CreatureId } from '../themes/types';

export type NavClass = 'small' | 'person' | 'large';

/**
 * Side length in nav cells per class.
 * `large` is reserved: its feet land at y = 16ty + 18, so Character.tile reports ty + 1. The anchor/feet
 * convention must be reconciled with Character.tile before any creature maps to it.
 */
export const CLASS_K: Record<NavClass, number> = { small: 1, person: 2, large: 3 };

const SMALL_CREATURES: ReadonlySet<CreatureId> = new Set<CreatureId>(['cat', 'dog', 'slime', 'familiar', 'astro-cat', 'void-blob']);

/** Nav class of a body: small creatures squeeze through half-tile gaps; humans (undefined) and big creatures need a tile. */
export function navClassForCreature(id: CreatureId | undefined): NavClass {
  return id !== undefined && SMALL_CREATURES.has(id) ? 'small' : 'person';
}
