import { HERO_HAIR_COLORS, HERO_HAIR_STYLE_COUNT, HERO_SKIN_TONES } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { POSE_PROP } from './actors/poses';
import { DIZZY_FRAMES, EMOTE_ICON, STRAIN_ICON } from './drama';
import { CHARACTER_BITMAPS, HAIR_COLORS, HAIR_STYLES, hexToNumber, SKIN_TONES } from './textures';

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

describe('M12 drama textures', () => {
  const keys = [...Object.values(STRAIN_ICON), ...DIZZY_FRAMES, ...Object.values(EMOTE_ICON)];
  it('every STRAIN_ICON / DIZZY_FRAMES / EMOTE_ICON key has a bitmap', () => {
    for (const k of keys) expect(CHARACTER_BITMAPS[k], k).toBeDefined();
  });
  it('new icons are at most 7x7 before the outline and paint only from their palette', () => {
    for (const k of keys) {
      const b = CHARACTER_BITMAPS[k]!;
      if (['icon-sparkle', 'icon-zz'].includes(k)) continue;
      expect(b.rows.length, k).toBeLessThanOrEqual(7);
      for (const r of b.rows) {
        expect(r.length, k).toBeLessThanOrEqual(7);
        for (const ch of r) if (ch !== ' ') expect(b.palette[ch], `${k} '${ch}'`).toBeDefined();
      }
    }
  });
});

describe('M13 life art', () => {
  it('every POSE_PROP texture key has a bitmap using only its palette', () => {
    for (const k of Object.values(POSE_PROP)) {
      if (!k) continue;
      const b = CHARACTER_BITMAPS[k];
      expect(b, k).toBeDefined();
      for (const r of b!.rows) for (const ch of r) if (ch !== ' ') expect(b!.palette[ch], `${k} '${ch}'`).toBeDefined();
    }
  });
});
