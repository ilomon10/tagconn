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
  it('strips format characters but keeps ZWJ emoji sequences and subdivision flags', () => {
    expect(sanitizeDisplayText('a\u200Bb\u200Ec\u061Cd\u2066e')).toBe('a b c d e');
    const family = '👨‍👩‍👧';
    const scot = '🏴󠁧󠁢󠁳󠁣󠁴󠁿';
    expect(sanitizeDisplayText(family)).toBe(family);
    expect(sanitizeDisplayText(scot)).toBe(scot);
  });
  it('drops an orphaned high surrogate left by the pre-cut', () => {
    const out = clipDisplayText(`${'x'.repeat(5 + 64 + 9)}😀${'y'.repeat(100)}`, 5);
    expect(out).toBe('xxxx…');
    const edge = clipDisplayText(`${'x'.repeat(10 + 64 - 1)}😀😀`, 100);
    expect(edge.includes('\uD83D…')).toBe(false);
    expect(/[\uD800-\uDBFF]…?$/.test(edge)).toBe(false);
  });
  it('returns empty for a huge all-whitespace or control input', () => {
    expect(clipDisplayText(' \u0000\n'.repeat(1_000_000), 10)).toBe('');
  });
});
