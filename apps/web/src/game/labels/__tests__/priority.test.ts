import { describe, expect, it } from 'vitest';
import { sortByPriority } from '../priority';
import type { LabelSubject } from '../types';

const box = { w: 40, h: 12 };
const sub = (id: string, selected: boolean, waiting: boolean, recency: number): LabelSubject => ({
  id,
  anchor: { x: 0, y: 0 },
  box,
  selected,
  waiting,
  recency,
});

describe('sortByPriority', () => {
  it('puts the selected subject first regardless of recency', () => {
    const order = sortByPriority([sub('a', false, false, 100), sub('b', true, false, 1)]);
    expect(order.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('puts waiting/blocked ahead of plain others', () => {
    const order = sortByPriority([sub('old-waiting', false, true, 1), sub('new-other', false, false, 100)]);
    expect(order.map((s) => s.id)).toEqual(['old-waiting', 'new-other']);
  });

  it('orders plain others by most-recent first', () => {
    const order = sortByPriority([sub('older', false, false, 1), sub('newest', false, false, 3), sub('mid', false, false, 2)]);
    expect(order.map((s) => s.id)).toEqual(['newest', 'mid', 'older']);
  });

  it('breaks exact ties by id, stably', () => {
    const order = sortByPriority([sub('z', false, false, 5), sub('a', false, false, 5)]);
    expect(order.map((s) => s.id)).toEqual(['a', 'z']);
  });

  it('does not mutate the input array', () => {
    const input = [sub('a', false, false, 1), sub('b', true, false, 1)];
    const copy = [...input];
    sortByPriority(input);
    expect(input).toEqual(copy);
  });
});
