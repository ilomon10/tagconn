import { describe, expect, it } from 'vitest';
import { nextLifecycle } from './actorLifecycle';

describe('nextLifecycle', () => {
  it('a fresh actor desiring quest starts on quest', () => {
    expect(nextLifecycle({ desired: 'quest', prev: undefined, now: 0, idleLeaveSec: 300 })).toEqual({ state: 'quest', restingSince: null });
  });

  it('enters resting with a timestamp the first time it is absent from the cast', () => {
    const r = nextLifecycle({ desired: 'resting', prev: { state: 'quest', restingSince: null }, now: 1000, idleLeaveSec: 300 });
    expect(r).toEqual({ state: 'resting', restingSince: 1000 });
  });

  it('stays resting before idleLeaveSec elapses', () => {
    const r = nextLifecycle({ desired: 'resting', prev: { state: 'resting', restingSince: 1000 }, now: 1000 + 299_000, idleLeaveSec: 300 });
    expect(r).toEqual({ state: 'resting', restingSince: 1000 });
  });

  it('RESTING -> LEAVING once idleLeaveSec elapses', () => {
    const r = nextLifecycle({ desired: 'resting', prev: { state: 'resting', restingSince: 1000 }, now: 1000 + 300_000, idleLeaveSec: 300 });
    expect(r).toEqual({ state: 'leaving', restingSince: 1000 });
  });

  it('idleLeaveSec = 0 leaves at once instead of ever resting', () => {
    const r = nextLifecycle({ desired: 'resting', prev: { state: 'quest', restingSince: null }, now: 5, idleLeaveSec: 0 });
    expect(r).toEqual({ state: 'leaving', restingSince: 5 });
  });

  it('a rebind (desired back to quest) cancels a pending leave', () => {
    const r = nextLifecycle({ desired: 'quest', prev: { state: 'leaving', restingSince: 1000 }, now: 2000, idleLeaveSec: 300 });
    expect(r).toEqual({ state: 'quest', restingSince: null });
  });

  it('a rebind while still resting also returns straight to quest', () => {
    const r = nextLifecycle({ desired: 'quest', prev: { state: 'resting', restingSince: 1000 }, now: 1500, idleLeaveSec: 300 });
    expect(r).toEqual({ state: 'quest', restingSince: null });
  });

  it('leaving stays leaving (no timer, until the scene marks it gone)', () => {
    const r = nextLifecycle({ desired: 'leaving', prev: { state: 'leaving', restingSince: 1000 }, now: 999_999, idleLeaveSec: 300 });
    expect(r).toEqual({ state: 'leaving', restingSince: 1000 });
  });

  it('a non-persistent actor going straight to leaving carries no resting timestamp', () => {
    const r = nextLifecycle({ desired: 'leaving', prev: { state: 'quest', restingSince: null }, now: 10, idleLeaveSec: 300 });
    expect(r).toEqual({ state: 'leaving', restingSince: null });
  });
});
