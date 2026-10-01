// M14 W0w STUB: C1 owns the per-style label tables (docs/design/battles.md 3.7).
import type { BattleStyle } from '../../game/battle/types';

export type BattleLabelKind = 'move' | 'item' | 'branch' | 'skill' | 'class' | 'loot' | 'enemy' | 'type' | 'status';

/** Stub: the humanized id ("refactor-strike" -> "Refactor Strike"). */
export function battleLabel(_style: BattleStyle, _kind: BattleLabelKind, id: string): string {
  return id
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
