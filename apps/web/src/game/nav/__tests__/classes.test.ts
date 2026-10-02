import { describe, expect, it } from 'vitest';
import type { CreatureId } from '../../themes/types';
import { CLASS_K, navClassForCreature } from '../classes';

describe('navClassForCreature', () => {
  it('small creatures take one cell per side', () => {
    for (const id of ['cat', 'dog', 'slime', 'familiar', 'astro-cat', 'void-blob'] as const) expect(navClassForCreature(id), id).toBe('small');
  });

  it('humans and big creatures are persons (one tile)', () => {
    for (const id of ['monster', 'wolf', 'hover-hound', undefined] as (CreatureId | undefined)[]) expect(navClassForCreature(id), String(id)).toBe('person');
  });

  it('never returns the reserved large class', () => {
    const ids = ['cat', 'dog', 'slime', 'familiar', 'astro-cat', 'void-blob', 'monster', 'wolf', 'hover-hound', undefined] as (CreatureId | undefined)[];
    for (const id of ids) expect(navClassForCreature(id), String(id)).not.toBe('large');
  });

  it('a person is exactly SUB cells wide', () => {
    expect(CLASS_K).toEqual({ small: 1, person: 2, large: 3 });
  });
});
