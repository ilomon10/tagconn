import { describe, expect, it } from 'vitest';
import { clipDisplayText, sanitizeDisplayText } from './displayText';

describe('displayText', () => {
  it('strips control and bidi characters and collapses whitespace', () => {
    expect(sanitizeDisplayText('a\nb\t‮c⁦d  e')).toBe('a b c d e');
  });
  it('keeps short text as is', () => {
    expect(clipDisplayText('Fix login', 20)).toBe('Fix login');
  });
  it('clips by code point with an ellipsis', () => {
    expect(clipDisplayText('😀😀😀😀', 3)).toBe('😀😀…');
    expect(clipDisplayText('abcdef', 4)).toBe('abc…');
  });
  it('handles empty, nullish and non-positive max', () => {
    expect(clipDisplayText(undefined, 5)).toBe('');
    expect(clipDisplayText('abc', 0)).toBe('');
  });
  it('never scans a huge string', () => {
    const huge = 'x'.repeat(5_000_000);
    expect(clipDisplayText(huge, 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
