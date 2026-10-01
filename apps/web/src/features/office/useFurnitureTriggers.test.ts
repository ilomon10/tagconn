import { describe, expect, it, vi } from 'vitest';
import type { FurnitureAction } from '../../game/procgen/types';
import { routeFurnitureClick } from './useFurnitureTriggers';

const ACTIONS: FurnitureAction[] = ['board', 'log', 'quests', 'settings', 'heroes', 'receptionist'];

function deps(over: { modalOpen?: boolean; disabled?: Partial<Record<string, boolean>> } = {}) {
  const runs = Object.fromEntries(['board', 'log', 'quests', 'settings', 'heroes'].map((a) => [a, vi.fn()]));
  const panels = Object.fromEntries(Object.entries(runs).map(([a, run]) => [a, { run, disabled: over.disabled?.[a] ?? false }])) as never;
  const openReceptionist = vi.fn();
  return { runs, openReceptionist, d: { modalOpen: over.modalOpen ?? false, panels, openReceptionist } };
}

describe('routeFurnitureClick', () => {
  it('routes each of the five panel actions to its run', () => {
    for (const a of ACTIONS.filter((x) => x !== 'receptionist')) {
      const { runs, openReceptionist, d } = deps();
      expect(routeFurnitureClick(a, d)).toBe(true);
      expect(runs[a]).toHaveBeenCalledTimes(1);
      expect(openReceptionist).not.toHaveBeenCalled();
    }
  });
  it('opens the receptionist panel directly', () => {
    const { runs, openReceptionist, d } = deps();
    expect(routeFurnitureClick('receptionist', d)).toBe(true);
    expect(openReceptionist).toHaveBeenCalledTimes(1);
    for (const r of Object.values(runs)) expect(r).not.toHaveBeenCalled();
  });
  it('ignores every action while a modal is open', () => {
    for (const a of ACTIONS) {
      const { runs, openReceptionist, d } = deps({ modalOpen: true });
      expect(routeFurnitureClick(a, d)).toBe(false);
      expect(openReceptionist).not.toHaveBeenCalled();
      for (const r of Object.values(runs)) expect(r).not.toHaveBeenCalled();
    }
  });
  it('skips a disabled action (heroes without a floor)', () => {
    const { runs, d } = deps({ disabled: { heroes: true } });
    expect(routeFurnitureClick('heroes', d)).toBe(false);
    expect(runs.heroes).not.toHaveBeenCalled();
  });
});
