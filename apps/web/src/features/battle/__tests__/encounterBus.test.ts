import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encounterBus } from '../encounterBus';
import type { EncounterOffer } from '../types';

const offer: EncounterOffer = { npcId: 'n1', kind: 'sales-dog', name: 'Sales Dog', style: 'modern', projectId: 'p', at: 1 };

beforeEach(() => encounterBus.clear());

describe('encounterBus', () => {
  it('delivers each channel to its subscribers and unsubscribes', () => {
    const o = vi.fn(), s = vi.fn(), c = vi.fn(), w = vi.fn();
    const offs = [encounterBus.onOffer(o), encounterBus.onShown(s), encounterBus.onChoice(c), encounterBus.onWithdraw(w)];
    encounterBus.offer(offer);
    encounterBus.shown('n1');
    encounterBus.choose('n1', 'battle');
    encounterBus.withdraw('n1');
    expect(o).toHaveBeenCalledWith(offer);
    expect(s).toHaveBeenCalledWith('n1');
    expect(c).toHaveBeenCalledWith('n1', 'battle');
    expect(w).toHaveBeenCalledWith('n1');
    offs.forEach((off) => off());
    encounterBus.offer(offer);
    expect(o).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not break the others', () => {
    const good = vi.fn();
    encounterBus.onShown(() => {
      throw new Error('boom');
    });
    encounterBus.onShown(good);
    expect(() => encounterBus.shown('n1')).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('clear drops every listener', () => {
    const cb = vi.fn();
    encounterBus.onChoice(cb);
    encounterBus.clear();
    encounterBus.choose('n1', 'ignore');
    expect(cb).not.toHaveBeenCalled();
  });
});
