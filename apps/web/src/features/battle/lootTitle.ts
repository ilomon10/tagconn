// M14 L1: loot cosmetics helpers (docs/design/battles.md 3.9).
import { LOOT_IDS, lootGrant, type HeroProgress, type LootHat, type LootId, type LootProp } from '@tagconn/shared';
import type { BattleStyle } from '../../game/battle/types';
import { battleLabel } from './labels';

const STYLES: readonly string[] = ['modern', 'guild', 'rift'];

/** A theme id (or the Multiverse id) as a battle label style; anything unknown reads as modern. */
export function battleStyleOf(themeId: string): BattleStyle {
  return STYLES.includes(themeId) ? (themeId as BattleStyle) : 'modern';
}

/** The equipped loot title's themed label, or null (none equipped, not owned, or not a title). */
export function equippedTitleLabel(progress: Pick<HeroProgress, 'loot' | 'equippedTitle'> | undefined, style: BattleStyle): string | null {
  const id = progress?.equippedTitle;
  if (!id || !progress.loot.includes(id) || lootGrant(id).kind !== 'title') return null;
  return battleLabel(style, 'loot', id);
}

/**
 * The name-plate title. Precedence: equipped loot title > the hero's own custom title > the themed role title.
 * `roleTitleFn` gets the hero's custom title (or null) and returns the usual `titleFor` result.
 */
export function plateTitle(
  hero: { title: string | null | undefined },
  progress: Pick<HeroProgress, 'loot' | 'equippedTitle'> | undefined,
  theme: { id: string },
  roleTitleFn: (heroTitle: string | null) => string,
): string {
  return equippedTitleLabel(progress, battleStyleOf(theme.id)) ?? roleTitleFn(hero.title || null);
}

/** Owned loot ids of one cosmetic kind, in catalogue order. */
export function ownedLoot(progress: Pick<HeroProgress, 'loot'> | undefined, kind: 'hat'): LootHat[];
export function ownedLoot(progress: Pick<HeroProgress, 'loot'> | undefined, kind: 'prop'): LootProp[];
export function ownedLoot(progress: Pick<HeroProgress, 'loot'> | undefined, kind: 'hat' | 'prop'): (LootHat | LootProp)[] {
  const out: (LootHat | LootProp)[] = [];
  for (const id of LOOT_IDS) {
    if (!progress?.loot.includes(id)) continue;
    const g = lootGrant(id);
    if (g.kind === 'hat' && kind === 'hat') out.push(g.hat);
    else if (g.kind === 'prop' && kind === 'prop') out.push(g.prop);
  }
  return out;
}

export const lootIdOf = (kind: 'hat' | 'prop', item: string): LootId => `${kind}-${item}` as LootId;
