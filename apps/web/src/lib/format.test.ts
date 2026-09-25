import { describe, expect, it } from 'vitest';
import { formatTokens } from './format';

describe('formatTokens', () => {
  it('leaves sub-thousand counts as plain integers', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats thousands with one decimal, dropping a trailing .0', () => {
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(1000)).toBe('1k');
    expect(formatTokens(12300)).toBe('12.3k');
    expect(formatTokens(999_949)).toBe('999.9k');
  });

  it('formats millions the same way', () => {
    expect(formatTokens(1234567)).toBe('1.2M');
    expect(formatTokens(1_000_000)).toBe('1M');
  });

  it('handles negative and non-finite input defensively', () => {
    expect(formatTokens(-1234)).toBe('-1.2k');
    expect(formatTokens(NaN)).toBe('0');
  });
});
