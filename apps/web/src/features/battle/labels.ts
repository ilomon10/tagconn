// M14 C1: per-style label tables (docs/design/battles.md 3.7). The tables live in content/{modern,guild,rift}.ts.
import { SKILL_TREES, type BattleNpcKind, type BattleType, type ClassId, type ItemId, type LootId, type SkillEffect, type SkillId } from '@tagconn/shared';
import type { BattleStyle } from '../../game/battle/types';
import { GUILD_LABELS } from './content/guild';
import { MODERN_LABELS } from './content/modern';
import { RIFT_LABELS } from './content/rift';

export type BattleLabelKind = 'move' | 'item' | 'branch' | 'skill' | 'class' | 'loot' | 'enemy' | 'type' | 'status';
export type StatusLabelId = 'stunned' | 'merge-conflict' | 'burnout' | 'buffed' | 'shielded';

export interface BattleLabels {
  move: Record<string, string>;
  item: Record<ItemId, string>;
  branch: Record<`${ClassId}.${0 | 1 | 2}`, string>;
  skill: Partial<Record<SkillId, string>>;
  class: Record<ClassId, string>;
  loot: Record<LootId, string>;
  enemy: Record<BattleNpcKind, string>;
  type: Record<BattleType, string>;
  status: Record<StatusLabelId, string>;
}

export const BATTLE_LABELS: Readonly<Record<BattleStyle, BattleLabels>> = { modern: MODERN_LABELS, guild: GUILD_LABELS, rift: RIFT_LABELS };

/** The humanized id ("refactor-strike" -> "Refactor Strike"); the fallback for unknown ids. */
function humanize(id: string): string {
  return id
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** "+4% ATK" style text for a passive skill node. */
export function passiveText(e: SkillEffect): string {
  switch (e.kind) {
    case 'stat': return `+${e.pctPerRank}% ${e.stat.toUpperCase()}`;
    case 'crit': return `+${e.pctPerRank}% crit`;
    case 'focusRegen': return `+${e.perRank} FOCUS/turn`;
    case 'statusResist': return `+${e.pctPerRank}% status resist`;
    case 'healBoost': return `+${e.pctPerRank}% healing`;
    case 'typeBoost': return `+${e.pctPerRank}% type damage`;
    case 'move': return '';
  }
}

function skillLabel(style: BattleStyle, id: string): string {
  const table = BATTLE_LABELS[style].skill;
  if (Object.hasOwn(table, id)) return table[id as SkillId] as string;
  const m = /^([a-z]+)\.[0-2]\.[1-4]$/.exec(id);
  const node = m ? SKILL_TREES[m[1] as ClassId]?.nodes.find((n) => n.id === id) : undefined;
  if (!node) return humanize(id);
  return node.effect.kind === 'move' ? battleLabel(style, 'move', node.effect.moveId) : passiveText(node.effect);
}

/** Themed name for an id; unknown ids fall back to the humanized id. */
export function battleLabel(style: BattleStyle, kind: BattleLabelKind, id: string): string {
  if (kind === 'skill') return skillLabel(style, id);
  const table = BATTLE_LABELS[style][kind] as Record<string, string>;
  return Object.hasOwn(table, id) ? (table[id] as string) : humanize(id);
}
