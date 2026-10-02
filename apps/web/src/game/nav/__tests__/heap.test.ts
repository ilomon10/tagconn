import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../procgen/rng';
import { NodeHeap } from '../heap';

const drain = (h: NodeHeap): number[] => {
  const out: number[] = [];
  for (let id = h.pop(); id !== -1; id = h.pop()) out.push(id);
  return out;
};

describe('NodeHeap', () => {
  it('pops by f ascending', () => {
    const h = new NodeHeap(4);
    h.push(1, 5, 0);
    h.push(2, 1, 0);
    h.push(3, 3, 0);
    expect(h.size).toBe(3);
    expect(drain(h)).toEqual([2, 3, 1]);
    expect(h.size).toBe(0);
    expect(h.pop()).toBe(-1);
  });

  it('breaks f ties by h, then h ties by id (deterministic)', () => {
    const h = new NodeHeap(2);
    h.push(9, 10, 4);
    h.push(7, 10, 2);
    h.push(8, 10, 2);
    h.push(1, 10, 9);
    h.push(5, 10, 2);
    expect(drain(h)).toEqual([5, 7, 8, 9, 1]);
  });

  it('grows past its initial capacity and clear() empties it', () => {
    const h = new NodeHeap(1);
    for (let i = 0; i < 100; i++) h.push(i, 100 - i, 0);
    expect(h.size).toBe(100);
    expect(drain(h)).toEqual(Array.from({ length: 100 }, (_, i) => 99 - i));
    h.push(3, 1, 1);
    h.clear();
    expect(h.size).toBe(0);
    expect(h.pop()).toBe(-1);
  });

  it('matches a sort of the same keys on random input', () => {
    const rnd = mulberry32(7);
    for (let round = 0; round < 50; round++) {
      const h = new NodeHeap(8);
      const items: { id: number; f: number; h: number }[] = [];
      const n = 1 + Math.floor(rnd() * 300);
      for (let i = 0; i < n; i++) {
        const it = { id: Math.floor(rnd() * 64), f: Math.floor(rnd() * 10), h: Math.floor(rnd() * 4) };
        items.push(it);
        h.push(it.id, it.f, it.h);
      }
      const expected = [...items].sort((a, b) => a.f - b.f || a.h - b.h || a.id - b.id).map((it) => it.id);
      expect(drain(h)).toEqual(expected);
    }
  });
});
