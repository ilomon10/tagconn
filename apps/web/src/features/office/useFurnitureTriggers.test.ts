import { describe, expect, it, vi } from 'vitest';
import type { FurnitureAction } from '../../game/procgen/types';
import { routeFurnitureClick } from './useFurnitureTriggers';

const ACTIONS: FurnitureAction[] = ['board', 'log', 'quests', 'settings', 'heroes', 'receptionist'];

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
