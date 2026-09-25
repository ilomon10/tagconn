import type { LabelSubject } from './types';

type Prioritized = Pick<LabelSubject, 'id' | 'selected' | 'waiting' | 'recency'>;

const tier = (s: Pick<LabelSubject, 'selected' | 'waiting'>): number => (s.selected ? 0 : s.waiting ? 1 : 2);

/**
 * ROADMAP.md M8 8e's priority order: selected > waiting-for-you/blocked > most recent > others,
 * with the id as a final, stable tiebreak so equal-recency subjects don't reorder from frame to
 * frame. Generic over any superset of `LabelSubject` so `layoutLabels` can reuse it directly.
 */
export function sortByPriority<T extends Prioritized>(subjects: T[]): T[] {
  return [...subjects].sort((a, b) => tier(a) - tier(b) || b.recency - a.recency || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
