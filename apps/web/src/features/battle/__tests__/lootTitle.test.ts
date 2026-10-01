import { describe, expect, it } from 'vitest';
import { battleStyleOf, equippedTitleLabel, lootIdOf, ownedLoot, plateTitle } from '../lootTitle';
import { battleLabel } from '../labels';

const prog = { loot: ['hat-fedora', 'prop-mop', 'title-redacted'], equippedTitle: 'title-redacted' } as const;
const mutable = (p: { loot: readonly string[]; equippedTitle: string | null }) => p as never;

describe('plateTitle', () => {
  const roleFn = (t: string | null) => t ?? 'Role Title';
  it('equipped loot title wins over a custom title', () => {
    expect(plateTitle({ title: 'Boss' }, mutable(prog), { id: 'modern' }, roleFn)).toBe(battleLabel('modern', 'loot', 'title-redacted'));
  });
  it('custom hero title beats the role title', () => {
    expect(plateTitle({ title: 'Boss' }, undefined, { id: 'guild' }, roleFn)).toBe('Boss');
  });
  it('falls back to the themed role title', () => {
    expect(plateTitle({ title: null }, mutable({ loot: [], equippedTitle: null }), { id: 'guild' }, roleFn)).toBe('Role Title');
  });
  it('ignores an equipped title that is not owned or not a title', () => {
    expect(equippedTitleLabel(mutable({ loot: [], equippedTitle: 'title-redacted' }), 'modern')).toBeNull();
    expect(equippedTitleLabel(mutable({ loot: ['hat-cap'], equippedTitle: 'hat-cap' }), 'modern')).toBeNull();
  });
  it('uses the theme style for the label; multiverse reads as modern', () => {
    expect(plateTitle({ title: null }, mutable(prog), { id: 'rift' }, roleFn)).toBe(battleLabel('rift', 'loot', 'title-redacted'));
    expect(battleStyleOf('multiverse')).toBe('modern');
  });
});

describe('ownedLoot', () => {
  it('lists only owned hats / props', () => {
    expect(ownedLoot(mutable(prog), 'hat')).toEqual(['fedora']);
    expect(ownedLoot(mutable(prog), 'prop')).toEqual(['mop']);
    expect(ownedLoot(undefined, 'hat')).toEqual([]);
    expect(lootIdOf('hat', 'cap')).toBe('hat-cap');
  });
});
