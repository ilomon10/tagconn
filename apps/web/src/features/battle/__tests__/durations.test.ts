import type { BattleEvent } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { eventDurationMs } from '../durations';

const damage: BattleEvent = { k: 'damage', target: { side: 'enemy' }, amount: 5, hp: 10, eff: 'normal', crit: false, selfHit: false };

describe('eventDurationMs', () => {
  it('uses the base time for short text', () => {
    expect(eventDurationMs(damage, 'Hit', false)).toBe(650);
    expect(eventDurationMs({ k: 'faint', target: { side: 'enemy' } }, 'x', false)).toBe(900);
  });
  it('stretches for long text (length / 40 s + 250 ms)', () => {
    expect(eventDurationMs(damage, 'x'.repeat(80), false)).toBe(2250);
  });
  it('start, turn and focus stay 0', () => {
    for (const e of [{ k: 'start' }, { k: 'turn', turn: 1 }, { k: 'focus', target: { side: 'enemy' }, amount: 1, focus: 1 }] as BattleEvent[]) {
      expect(eventDurationMs(e, 'some text', false)).toBe(0);
      expect(eventDurationMs(e, 'some text', true)).toBe(0);
    }
  });
  it('reduced motion is 60 % with a 300 ms floor', () => {
    expect(eventDurationMs(damage, 'Hit', true)).toBe(390);
    expect(eventDurationMs({ k: 'miss', by: { side: 'enemy' } }, 'Miss', true)).toBe(300);
  });
});
