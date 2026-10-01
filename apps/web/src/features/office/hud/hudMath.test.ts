import { describe, expect, it } from 'vitest';
import type { StrainKind } from '../../../game/themes/types';
import { hudLabels, strainSentence, xpLevel } from './hudMath';

describe('hudLabels', () => {
  it('uses plain words on modern and game words on guild and rift', () => {
    expect(hudLabels('modern')).toEqual({ mana: 'Context', xp: 'Tokens' });
    expect(hudLabels('guild')).toEqual({ mana: 'Mana', xp: 'XP' });
    expect(hudLabels('rift')).toEqual({ mana: 'Mana', xp: 'XP' });
  });
});

describe('xpLevel', () => {
  it('is 1 + floor(sqrt(tokens / 25k))', () => {
    expect(xpLevel(0)).toBe(1);
    expect(xpLevel(24_999)).toBe(1);
    expect(xpLevel(25_000)).toBe(2);
    expect(xpLevel(99_999)).toBe(2);
    expect(xpLevel(100_000)).toBe(3);
    expect(xpLevel(2_500_000)).toBe(11);
  });

  it('clamps to 1..99 and survives bad input', () => {
    expect(xpLevel(-5)).toBe(1);
    expect(xpLevel(Number.NaN)).toBe(1);
    expect(xpLevel(25_000 * 98 * 98)).toBe(99);
    expect(xpLevel(1e15)).toBe(99);
  });
});

describe('strainSentence', () => {
  const now = 1_000_000;
  const agent = { status: 'active', activity: 'running', startedAt: now - 3_725_000, updatedAt: now - 125_000, toolStartedAt: now - 130_000, currentTool: 'Bash' } as const;

  it('words each kind with its own timer', () => {
    expect(strainSentence('dizzy', agent, now)).toBe('Dizzy · Bash running 2m 10s');
    expect(strainSentence('sweating', { ...agent, status: 'waiting' }, now)).toBe('Sweating · waiting for you 2m 05s');
    expect(strainSentence('sweating', { ...agent, status: 'blocked' }, now)).toBe('Sweating · blocked 2m 05s');
    expect(strainSentence('tired', agent, now)).toBe('Tired · on this quest 1h 02m');
    expect(strainSentence('on-a-roll', agent, now)).toBe('On a roll · tools flying');
  });

  it('names a tool-less dizzy generically and falls back to updatedAt', () => {
    expect(strainSentence('dizzy', { ...agent, currentTool: undefined, toolStartedAt: undefined }, now)).toBe('Dizzy · tool running 2m 05s');
  });

  it('answers every kind', () => {
    for (const k of ['dizzy', 'sweating', 'tired', 'on-a-roll'] as StrainKind[]) expect(strainSentence(k, agent, now).length).toBeGreaterThan(4);
  });
});
