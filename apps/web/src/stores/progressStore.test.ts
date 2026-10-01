import { beforeEach, describe, expect, it } from 'vitest';
import type { HeroProgress } from '@tagconn/shared';
import { getProgress, registerProgressEvents, useProgressStore } from './progressStore';
import type { OfficeSocket } from '../lib/socket';

const prog = (heroId: string, over: Partial<HeroProgress> = {}): HeroProgress => ({
  heroId, projectId: 'p', classId: 'developer', xp: 0, level: 1, levelXp: 0, nextLevelXp: 100, skillPoints: 0, bonusPoints: 0,
  skills: {}, overspent: false, koUntil: null, wins: 0, losses: 0, flees: 0, loot: [], equippedTitle: null, updatedAt: 1, ...over,
});

beforeEach(() => useProgressStore.setState({ progress: Object.create(null) as Record<string, HeroProgress> }));

describe('progressStore', () => {
  it('setAll replaces, upsert merges, remove drops', () => {
    const s = useProgressStore.getState();
    s.setAll([prog('h-aaaaaaaa'), prog('h-bbbbbbbb')]);
    expect(Object.keys(useProgressStore.getState().progress).sort()).toEqual(['h-aaaaaaaa', 'h-bbbbbbbb']);
    s.upsert(prog('h-aaaaaaaa', { xp: 5 }));
    expect(getProgress(useProgressStore.getState().progress, 'h-aaaaaaaa')?.xp).toBe(5);
    s.remove('h-bbbbbbbb');
    expect(getProgress(useProgressStore.getState().progress, 'h-bbbbbbbb')).toBeUndefined();
    s.setAll([prog('h-cccccccc')]);
    expect(Object.keys(useProgressStore.getState().progress)).toEqual(['h-cccccccc']);
  });

  it('is prototype-safe', () => {
    const s = useProgressStore.getState();
    s.upsert(prog('h-aaaaaaaa'));
    const map = useProgressStore.getState().progress;
    expect(Object.getPrototypeOf(map)).toBeNull();
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) expect(getProgress(map, k)).toBeUndefined();
    s.remove('constructor');
    expect(useProgressStore.getState().progress).toBe(map); // no-op keeps identity
    s.upsert(prog('h-bbbbbbbb'));
    expect(Object.getPrototypeOf(useProgressStore.getState().progress)).toBeNull();
  });

  it('registerProgressEvents wires hero:progress and hero:remove', () => {
    const handlers: Record<string, (v: never) => void> = {};
    const socket = { on: (ev: string, cb: (v: never) => void) => void (handlers[ev] = cb) } as unknown as OfficeSocket;
    registerProgressEvents(socket);
    handlers['hero:progress']?.(prog('h-aaaaaaaa', { xp: 9 }) as never);
    expect(getProgress(useProgressStore.getState().progress, 'h-aaaaaaaa')?.xp).toBe(9);
    handlers['hero:remove']?.('h-aaaaaaaa' as never);
    expect(getProgress(useProgressStore.getState().progress, 'h-aaaaaaaa')).toBeUndefined();
  });
});
