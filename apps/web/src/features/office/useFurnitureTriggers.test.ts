import { describe, expect, it, vi } from 'vitest';
import type { FurnitureAction } from '../../game/procgen/types';
import type { Hero, HeroProgress } from '@tagconn/shared';
import { koHeroIds, routeFurnitureClick, runCoffeeBreak } from './useFurnitureTriggers';

const ACTIONS: Exclude<FurnitureAction, 'infirmary'>[] = ['board', 'log', 'quests', 'settings', 'heroes', 'receptionist'];

function deps(over: { modalOpen?: boolean; disabled?: Partial<Record<string, boolean>> } = {}) {
  const runs = Object.fromEntries(['board', 'log', 'quests', 'settings', 'heroes', 'receptionist'].map((a) => [a, vi.fn()]));
  const panels = Object.fromEntries(Object.entries(runs).map(([a, run]) => [a, { run, disabled: over.disabled?.[a] ?? false }])) as never;
  return { runs, d: { modalOpen: over.modalOpen ?? false, panels } };
}

describe('routeFurnitureClick', () => {
  it('routes each of the six actions to its run (the receptionist too, so the admin guard applies)', () => {
    for (const a of ACTIONS) {
      const { runs, d } = deps();
      expect(routeFurnitureClick(a, d)).toBe(true);
      expect(runs[a]).toHaveBeenCalledTimes(1);
    }
  });
  it('ignores every action while a modal is open', () => {
    for (const a of ACTIONS) {
      const { runs, d } = deps({ modalOpen: true });
      expect(routeFurnitureClick(a, d)).toBe(false);
      for (const r of Object.values(runs)) expect(r).not.toHaveBeenCalled();
    }
  });
  it('skips a disabled action (heroes without a floor)', () => {
    const { runs, d } = deps({ disabled: { heroes: true } });
    expect(routeFurnitureClick('heroes', d)).toBe(false);
    expect(runs.heroes).not.toHaveBeenCalled();
  });
});

describe('coffee break', () => {
  const hero = (id: string, projectId: string) => ({ id, projectId }) as Hero;
  const prog = (heroId: string, koUntil: number | null) => ({ heroId, koUntil }) as HeroProgress;
  const heroes = { h1: hero('h1', 'a'), h2: hero('h2', 'a'), h3: hero('h3', 'b') };
  const progress = { h1: prog('h1', 2000), h2: prog('h2', 500), h3: prog('h3', 3000) };

  it('picks only the KO\'d heroes of the selected floor (all of them on the multiverse floor)', () => {
    expect(koHeroIds(heroes, progress, 'a', 1000)).toEqual(['h1']);
    expect(koHeroIds(heroes, progress, 'b', 1000)).toEqual(['h3']);
    expect(koHeroIds(heroes, progress, 'c', 1000)).toEqual([]);
  });
  const run = (over: Partial<Parameters<typeof runCoffeeBreak>[0]> = {}) => {
    const heal = vi.fn(() => Promise.resolve());
    const cue = vi.fn();
    const n = runCoffeeBreak({ modalOpen: false, allowed: true, heroIds: ['h1', 'h2'], heal, cue, ...over });
    return { n, heal, cue };
  };
  it('heals each KO\'d hero and plays the cue once', () => {
    const { n, heal, cue } = run();
    expect(n).toBe(2);
    expect(heal).toHaveBeenCalledTimes(2);
    expect(cue).toHaveBeenCalledTimes(1);
  });
  it('does nothing while a modal is open, without write access, or with nobody to heal', () => {
    for (const over of [{ modalOpen: true }, { allowed: false }, { heroIds: [] }]) {
      const { n, heal, cue } = run(over);
      expect(n).toBe(0);
      expect(heal).not.toHaveBeenCalled();
      expect(cue).not.toHaveBeenCalled();
    }
  });
  it('swallows a failed heal', async () => {
    const { n } = run({ heal: () => Promise.reject(new Error('409')) });
    expect(n).toBe(2);
    await Promise.resolve();
  });
});
