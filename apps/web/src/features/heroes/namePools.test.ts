import { HERO_LIMITS, type HeroNamePools } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { normalizePoolsForSave, parsePoolText, poolText, poolTextInSync, rolesForNamePools, validateNamePools } from './namePools';

describe('parsePoolText', () => {
  it('splits on newlines, trims, and drops blank lines', () => {
    expect(parsePoolText(' Brom \n\n  Tamsin\n \nWendel ')).toEqual(['Brom', 'Tamsin', 'Wendel']);
  });

  it('is empty for an empty or whitespace-only string', () => {
    expect(parsePoolText('')).toEqual([]);
    expect(parsePoolText('   \n  \n')).toEqual([]);
  });
});

describe('poolText', () => {
  it("joins a role's own names with newlines", () => {
    expect(poolText({ developer: ['Brom', 'Tamsin'] }, 'developer')).toBe('Brom\nTamsin');
  });

  it('is empty for a role with no own pool, even if `default` has entries (own-property only)', () => {
    expect(poolText({ default: ['Rook'] }, 'developer')).toBe('');
  });
});

describe('rolesForNamePools', () => {
  it('unions known roles with roles already present in pools, de-duped, `default` last', () => {
    const pools: HeroNamePools = { developer: ['Brom'], custom_role: ['X'] };
    expect(rolesForNamePools(['pm', 'developer'], pools)).toEqual(['custom_role', 'developer', 'pm', 'default']);
  });

  it('always includes `default` even if absent from both inputs', () => {
    expect(rolesForNamePools(['pm'], {})).toEqual(['pm', 'default']);
  });
});

describe('validateNamePools', () => {
  it('is empty for a valid pool set', () => {
    expect(validateNamePools({ developer: ['Brom', 'Tamsin'] })).toEqual([]);
  });

  it('flags too many names', () => {
    const names = Array.from({ length: HERO_LIMITS.maxPoolNames + 1 }, (_, i) => `N${i}`);
    const issues = validateNamePools({ developer: names });
    expect(issues.some((i) => i.role === 'developer' && /At most/.test(i.message))).toBe(true);
  });

  it('flags case-insensitive duplicates', () => {
    const issues = validateNamePools({ developer: ['Brom', 'brom', 'Tamsin'] });
    expect(issues.some((i) => i.role === 'developer' && /Duplicate/.test(i.message) && i.message.includes('brom'))).toBe(true);
  });

  it('flags a name longer than the limit', () => {
    const tooLong = 'x'.repeat(HERO_LIMITS.maxNameLength + 1);
    const issues = validateNamePools({ developer: [tooLong] });
    expect(issues.some((i) => i.role === 'developer' && /Too long/.test(i.message))).toBe(true);
  });
});

describe('poolTextInSync', () => {
  it('keeps raw text with trailing space/newline in sync with its parsed names', () => {
    expect(poolTextInSync('Brom ', ['Brom'])).toBe(true);
    expect(poolTextInSync('Brom\n', ['Brom'])).toBe(true);
    expect(poolTextInSync('Brom\n\nTamsin', ['Brom', 'Tamsin'])).toBe(true);
    expect(poolTextInSync('', [])).toBe(true);
  });

  it('detects an external change', () => {
    expect(poolTextInSync('Brom', ['Tamsin'])).toBe(false);
    expect(poolTextInSync('Brom', [])).toBe(false);
  });
});

describe('normalizePoolsForSave', () => {
  it('drops emptied roles but keeps the rest', () => {
    expect(normalizePoolsForSave({ developer: [], pm: ['Aldric'] })).toEqual({ pm: ['Aldric'] });
  });
});
