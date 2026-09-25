import { HERO_HAIR_COLORS, HERO_HAIR_STYLE_COUNT, HERO_SKIN_TONES } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { HAIR_COLORS, HAIR_STYLES, hexToNumber, SKIN_TONES } from './textures';

// W4 acceptance: the web palettes stay equal to the shared `HERO_*` vocabulary (packages/shared/src/heroes.ts).
describe('palettes match the shared HERO_* vocabulary', () => {
  it('HAIR_COLORS equals HERO_HAIR_COLORS', () => {
    expect(HAIR_COLORS).toEqual(HERO_HAIR_COLORS.map(hexToNumber));
    expect(HAIR_COLORS).toHaveLength(HERO_HAIR_COLORS.length);
  });

  it('SKIN_TONES equals HERO_SKIN_TONES', () => {
    expect(SKIN_TONES).toEqual(HERO_SKIN_TONES.map(hexToNumber));
    expect(SKIN_TONES).toHaveLength(HERO_SKIN_TONES.length);
  });

  it('HAIR_STYLES equals HERO_HAIR_STYLE_COUNT', () => {
    expect(HAIR_STYLES).toBe(HERO_HAIR_STYLE_COUNT);
  });
});

describe('hexToNumber', () => {
  it('parses a #rrggbb string to its numeric value', () => {
    expect(hexToNumber('#f5c89a')).toBe(0xf5c89a);
    expect(hexToNumber('#000000')).toBe(0);
    expect(hexToNumber('#ffffff')).toBe(0xffffff);
  });
});
