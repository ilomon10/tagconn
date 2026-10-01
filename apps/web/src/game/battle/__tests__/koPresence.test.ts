import { describe, expect, it, vi } from 'vitest';
import type { HeroProgress } from '@tagconn/shared';
import { KoPresence, koBadgeFor, type KoInput, type KoTarget } from '../koPresence';

const ko = { koUntil: 2000 } as HeroProgress;
const fine = { koUntil: null } as HeroProgress;
const work = { status: 'active', activity: 'typing' } as const;
const wait = { status: 'waiting', activity: 'waiting' } as const;
const idle = { status: 'active', activity: 'idle' } as const;
const q = (agent: KoInput['agent'], lifecycle: KoInput['lifecycle'] = 'quest'): KoInput => ({ heroId: 'h', lifecycle, agent });

describe('koBadgeFor', () => {
  it('truth table', () => {
    expect(koBadgeFor(q(work), ko, 1000)).toBe('bandage');
    expect(koBadgeFor(q(wait), ko, 1000)).toBe('bandage');
    expect(koBadgeFor(q({ status: 'blocked', activity: 'idle' }), ko, 1000)).toBe('bandage');
    expect(koBadgeFor(q(idle), ko, 1000)).toBe('dizzy');
    expect(koBadgeFor(q(undefined, 'resting'), ko, 1000)).toBe('dizzy');
    expect(koBadgeFor(q(work, 'leaving'), ko, 1000)).toBe('dizzy');
  });
  it('null when not KO, expired, unknown or no hero', () => {
    expect(koBadgeFor(q(work), fine, 1000)).toBeNull();
    expect(koBadgeFor(q(work), ko, 2000)).toBeNull();
    expect(koBadgeFor(q(work), undefined, 1000)).toBeNull();
    expect(koBadgeFor({ ...q(work), heroId: null }, ko, 1000)).toBeNull();
  });
});

describe('KoPresence.apply', () => {
  it('calls setKoBadge only on change and touches nothing else', () => {
    const c = { heroId: 'h', lifecycle: 'quest', setKoBadge: vi.fn(), walk: vi.fn(), teleport: vi.fn(), setSeated: vi.fn() } as KoTarget & Record<string, unknown>;
    const p = new KoPresence();
    let prog: HeroProgress = ko;
    const run = (now: number, a: KoInput['agent']) => p.apply([c], () => prog, () => a, now);
    run(1000, work);
    run(1100, work);
    expect(c.setKoBadge).toHaveBeenCalledTimes(1);
    expect(c.setKoBadge).toHaveBeenLastCalledWith('bandage');
    run(1200, idle);
    expect(c.setKoBadge).toHaveBeenLastCalledWith('dizzy');
    prog = fine;
    run(1300, idle);
    expect(c.setKoBadge).toHaveBeenLastCalledWith(null);
    expect(c.setKoBadge).toHaveBeenCalledTimes(3);
    for (const k of ['walk', 'teleport', 'setSeated']) expect(c[k]).not.toHaveBeenCalled();
  });
  it('does not call for a never-KO character', () => {
    const c: KoTarget = { heroId: 'h', lifecycle: 'quest', setKoBadge: vi.fn() };
    new KoPresence().apply([c], () => undefined, () => undefined, 1);
    expect(c.setKoBadge).toHaveBeenCalledTimes(1); // initial sync to null
  });
});
