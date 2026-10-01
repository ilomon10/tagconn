import { describe, expect, it } from 'vitest';
import { BIG_CHARS, GLYPHS_3X5, GLYPHS_5X7, SMALL_CHARS } from '../glyphs';
import { hasGlyphs } from '../pixelFont';

describe('glyph tables', () => {
  it('char orders cover the documented ranges', () => {
    expect(BIG_CHARS.startsWith(' !"#')).toBe(true);
    expect(BIG_CHARS).toContain('~');
    expect(BIG_CHARS.endsWith('·…')).toBe(true);
    expect(SMALL_CHARS).toContain('_');
    expect(SMALL_CHARS).not.toContain('a');
    expect(SMALL_CHARS.endsWith('·…')).toBe(true);
  });

  it('every 5x7 char has 9 rows (7 + 2 descender) of exactly 5 using only # and space', () => {
    for (const ch of BIG_CHARS) {
      const g = GLYPHS_5X7[ch];
      expect(g, `5x7 ${ch}`).toBeDefined();
      expect(g).toHaveLength(9);
      for (const r of g!) expect(r).toMatch(/^[# ]{5}$/);
    }
  });

  it('every 3x5 char has 5 rows of exactly 3 using only # and space', () => {
    for (const ch of SMALL_CHARS) {
      const g = GLYPHS_3X5[ch];
      expect(g, `3x5 ${ch}`).toBeDefined();
      expect(g).toHaveLength(5);
      for (const r of g!) expect(r).toMatch(/^[# ]{3}$/);
    }
  });

  it('has no glyphs outside the char orders', () => {
    expect(Object.keys(GLYPHS_5X7).sort()).toEqual([...BIG_CHARS].sort());
    expect(Object.keys(GLYPHS_3X5).sort()).toEqual([...SMALL_CHARS].sort());
  });

  it('visible glyphs have ink', () => {
    for (const ch of BIG_CHARS) if (ch !== ' ') expect(GLYPHS_5X7[ch]!.join('')).toContain('#');
    for (const ch of SMALL_CHARS) if (ch !== ' ') expect(GLYPHS_3X5[ch]!.join('')).toContain('#');
  });

  it('g j p q y have ink in the descender rows, nothing else does', () => {
    for (const ch of BIG_CHARS) {
      const tail = GLYPHS_5X7[ch]!.slice(7).join('');
      if ('gjpqy'.includes(ch)) expect(tail, ch).toContain('#');
      else expect(tail, ch).not.toContain('#');
    }
  });

  it('prints lowercase for eyeballing (a-z at 1x)', () => {
    const rows = Array.from({ length: 9 }, (_, r) =>
      [...'abcdefghijklmnopqrstuvwxyz'].map((c) => GLYPHS_5X7[c]![r]!.replaceAll(' ', '.').replaceAll('#', '@')).join(' '));
    expect(rows.join('\n')).toMatchSnapshot();
  });

  it('hasGlyphs: lowercase maps to the small set, unknown chars fail', () => {
    expect(hasGlyphs('Ada · Lovelace…', 'big')).toBe(true);
    expect(hasGlyphs('refactor the parser', 'small')).toBe(true);
    expect(hasGlyphs('日本', 'big')).toBe(false);
    expect(hasGlyphs('{x}', 'small')).toBe(false);
  });
});
