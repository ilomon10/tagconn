import { describe, expect, it } from 'vitest';
import { themedBubble } from '../verbs';
import type { ThemeDefinition } from '../types';

const withVerb: Pick<ThemeDefinition, 'activityVerbs'> = { activityVerbs: { typing: 'Inscribing runes' } };
const withoutVerb: Pick<ThemeDefinition, 'activityVerbs'> = { activityVerbs: {} };

describe('themedBubble', () => {
  it('leaves the bubble untouched when the theme has no verb for the activity (modern)', () => {
    expect(themedBubble(withoutVerb, 'typing', 'Editing auth.ts', 'Edit')).toBe('Editing auth.ts');
    expect(themedBubble(withoutVerb, 'typing', undefined, 'Edit')).toBe('');
  });

  it('uses the plain verb when the bubble is empty', () => {
    expect(themedBubble(withVerb, 'typing', undefined, 'Edit')).toBe('Inscribing runes');
    expect(themedBubble(withVerb, 'typing', '   ', 'Edit')).toBe('Inscribing runes');
  });

  it('uses the plain verb when the bubble is just the generic tool name', () => {
    expect(themedBubble(withVerb, 'typing', 'Edit', 'Edit')).toBe('Inscribing runes');
  });

  it('prefixes a meaningful bubble with the verb', () => {
    expect(themedBubble(withVerb, 'typing', 'auth.ts', 'Edit')).toBe('Inscribing runes · auth.ts');
  });

  it('trims the bubble before comparing/joining', () => {
    expect(themedBubble(withVerb, 'typing', '  auth.ts  ', 'Edit')).toBe('Inscribing runes · auth.ts');
  });
});
