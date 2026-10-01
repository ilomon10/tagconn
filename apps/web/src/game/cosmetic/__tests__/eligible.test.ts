import { describe, expect, it } from 'vitest';
import type { Agent } from '@tagconn/shared';
import type { Character } from '../../actors/Character';
import { isIdleEligible, waitingTiles } from '../eligible';

const ch = (over: Record<string, unknown> = {}) =>
  ({ gone: false, leaving: false, lifecycleFrame: { state: 'resting', restingSince: 0 }, boundAgentId: null, ...over }) as Parameters<typeof isIdleEligible>[0];
const agent = (over: Record<string, unknown> = {}) => ({ id: 'ag', status: 'active', activity: 'idle', ...over }) as unknown as Agent;

describe('isIdleEligible', () => {
  it('resting characters are eligible unless gone or leaving', () => {
    expect(isIdleEligible(ch(), undefined)).toBe(true);
    expect(isIdleEligible(ch({ gone: true }), undefined)).toBe(false);
    expect(isIdleEligible(ch({ leaving: true }), undefined)).toBe(false);
  });
  it('quest characters need a bound, active, idle agent', () => {
    const q = ch({ lifecycleFrame: { state: 'quest', restingSince: 0 } });
    expect(isIdleEligible(q, agent())).toBe(false); // no bound agent
    const bound = ch({ lifecycleFrame: { state: 'quest', restingSince: 0 }, boundAgentId: 'ag' });
    expect(isIdleEligible(bound, agent())).toBe(true);
    expect(isIdleEligible(bound, undefined)).toBe(false);
    expect(isIdleEligible(bound, agent({ status: 'waiting' }))).toBe(false);
    expect(isIdleEligible(bound, agent({ activity: 'typing' }))).toBe(false);
  });
});

describe('waitingTiles', () => {
  it('returns tiles of waiting or blocked characters only', () => {
    const mk = (x: number, isWaiting: boolean, gone = false) => ({ tile: { x, y: 1 }, isWaiting, gone }) as unknown as Character;
    expect(waitingTiles([mk(1, true), mk(2, false), mk(3, true, true), mk(4, true)])).toEqual([
      { x: 1, y: 1 },
      { x: 4, y: 1 },
    ]);
  });
});
