import { describe, expect, it } from 'vitest';
import { FACING_SUPPORT } from '../../game/procgen/facingSpec';
import { GLYPH_KINDS, facingTriangle, isRotatable, kindGlyph, kindLabel } from './glyphs';
import { PALETTE_GROUPS, PALETTE_KINDS } from './FurniturePalette';
import { PinnedFurnitureSchema } from '@tagconn/shared';
import { isPinnableKind } from './pins';

describe('glyphs', () => {
  it('covers every FurnitureKind with a non-empty glyph (and nothing else)', () => {
    expect([...GLYPH_KINDS].sort()).toEqual(Object.keys(FACING_SUPPORT).sort());
    for (const k of GLYPH_KINDS) expect(kindGlyph(k).length).toBeGreaterThan(0);
  });
  it('falls back for a kind that is not a real one (own-property lookup)', () => {
    expect(kindGlyph('constructor')).toBe('□');
    expect(kindGlyph('__proto__')).toBe('□');
    expect(isRotatable('constructor')).toBe(false);
  });
  it('labels kinds', () => {
    expect(kindLabel('work-desk')).toBe('Work desk');
  });
  it('isRotatable mirrors FACING_SUPPORT', () => {
    expect(isRotatable('bench')).toBe(true);
    expect(isRotatable('work-desk')).toBe(false);
  });
  it('the facing triangle hugs the facing edge, inside the rect', () => {
    const rect = { x: 10, y: 20, w: 40, h: 20 };
    const tip = (f: 'n' | 'e' | 's' | 'w') => facingTriangle(rect, f)[2]!;
    expect(tip('n')[1]).toBe(20);
    expect(tip('s')[1]).toBe(40);
    expect(tip('e')[0]).toBe(50);
    expect(tip('w')[0]).toBe(10);
    for (const f of ['n', 'e', 's', 'w'] as const) for (const [x, y] of facingTriangle(rect, f)) expect(x >= 10 && x <= 50 && y >= 20 && y <= 40).toBe(true);
  });
});

describe('palette', () => {
  it('lists unique, real, pinnable kinds that pass the pin schema', () => {
    expect(new Set(PALETTE_KINDS.map((k) => k.kind)).size).toBe(PALETTE_KINDS.length);
    for (const k of PALETTE_KINDS) {
      expect(GLYPH_KINDS).toContain(k.kind);
      expect(isPinnableKind(k.kind)).toBe(true);
      expect(PinnedFurnitureSchema.safeParse({ kind: k.kind, x: 0, y: 0, w: k.w, h: k.h }).success).toBe(true);
    }
    expect(PALETTE_GROUPS.length).toBeGreaterThan(0);
  });
});
