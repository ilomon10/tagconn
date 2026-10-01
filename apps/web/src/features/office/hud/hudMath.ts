import type { Agent, OfficeStyle } from '@tagconn/shared';
import type { StrainInput } from '../../../game/drama';
import type { StrainKind } from '../../../game/themes/types';
import { elapsed } from '../../../lib/format';

/** The card's two bar labels per floor style: plain words on modern floors, game words on guild and the rift. */
export function hudLabels(style: OfficeStyle | 'rift'): { mana: string; xp: string } {
  return style === 'modern' ? { mana: 'Context', xp: 'Tokens' } : { mana: 'Mana', xp: 'XP' };
}

/** 1 + floor(sqrt(tokens / 25_000)), clamped 1..99. */
export function xpLevel(totalTokens: number): number {
  const t = Number.isFinite(totalTokens) ? Math.max(0, totalTokens) : 0;
  return Math.min(99, Math.max(1, 1 + Math.floor(Math.sqrt(t / 25_000))));
}

const STRAIN_HEAD: Record<StrainKind, string> = { dizzy: 'Dizzy', sweating: 'Sweating', tired: 'Tired', 'on-a-roll': 'On a roll' };

/** The strain sentence for the card, e.g. "Dizzy · tool running 2m 10s". */
export function strainSentence(kind: StrainKind, agent: StrainInput & Pick<Agent, 'currentTool'>, now: number): string {
  const head = STRAIN_HEAD[kind];
  switch (kind) {
    case 'dizzy':
      return `${head} · ${agent.currentTool ?? 'tool'} running ${elapsed(agent.toolStartedAt ?? agent.updatedAt, now)}`;
    case 'sweating':
      return `${head} · ${agent.status === 'blocked' ? 'blocked' : 'waiting for you'} ${elapsed(agent.updatedAt, now)}`;
    case 'tired':
      return `${head} · on this quest ${elapsed(agent.startedAt, now)}`;
    case 'on-a-roll':
      return `${head} · tools flying`;
  }
}
