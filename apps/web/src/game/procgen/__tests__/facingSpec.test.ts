import { describe, expect, it } from 'vitest';
import { FACINGS } from '@tagconn/shared';
import { FACING_SUPPORT, facingSupported, footprintFor, frontStrip, nextFacing } from '../facingSpec';
import type { FurnitureKind } from '../types';

describe('facingSpec (M16)', () => {
  it('every kind lists only known facings and includes s', () => {
    for (const [kind, list] of Object.entries(FACING_SUPPORT)) {
      expect(list.includes('s'), kind).toBe(true);
      for (const f of list) expect(FACINGS).toContain(f);
    }
  });
  it('fixed kinds stay s; rotatable kinds cycle through all four', () => {
    expect(nextFacing('work-desk', 's')).toBe('s');
    const seen = new Set<string>();
    let f = nextFacing('bookcase', 's');
    for (let i = 0; i < 4; i++, f = nextFacing('bookcase', f)) seen.add(f);
    expect(seen.size).toBe(4);
    expect(facingSupported('bookcase', 'w')).toBe(true);
    expect(facingSupported('work-desk', 'n')).toBe(false);
  });
  it('a non-own key (constructor, __proto__) falls back to fixed s', () => {
    for (const k of ['constructor', '__proto__', 'toString']) {
      expect(facingSupported(k as FurnitureKind, 'n')).toBe(false);
      expect(facingSupported(k as FurnitureKind, 's')).toBe(true);
      expect(nextFacing(k as FurnitureKind, 'n')).toBe('s');
    }
  });
  it('footprintFor swaps w/h for e/w only; frontStrip is the clearance strip', () => {
    expect(footprintFor({ w: 3, h: 1 }, 'e')).toEqual({ w: 1, h: 3 });
    expect(footprintFor({ w: 3, h: 1 }, 'n')).toEqual({ w: 3, h: 1 });
    const r = { x: 4, y: 4, w: 2, h: 1 };
    expect(frontStrip(r, 's')).toEqual({ x: 4, y: 5, w: 2, h: 1 });
    expect(frontStrip(r, 'n', 2)).toEqual({ x: 4, y: 2, w: 2, h: 2 });
    expect(frontStrip(r, 'e')).toEqual({ x: 6, y: 4, w: 1, h: 1 });
    expect(frontStrip(r, 'w')).toEqual({ x: 3, y: 4, w: 1, h: 1 });
  });
});
