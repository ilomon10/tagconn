import { describe, expect, it } from 'vitest';
import { CHARACTER_BITMAPS, HAIR_STYLES, viewTexture } from '../../textures';
import { VIEW_OFFSETS } from '../views';
import { facingOf, viewOf, type Facing, type View } from '../walkQueue';

describe('viewOf', () => {
  it('w is the e view flipped; n, e and s are themselves', () => {
    expect(viewOf('s')).toEqual({ view: 's', flip: false });
    expect(viewOf('n')).toEqual({ view: 'n', flip: false });
    expect(viewOf('e')).toEqual({ view: 'e', flip: false });
    expect(viewOf('w')).toEqual({ view: 'e', flip: true });
  });

  it('a step vector maps to the view the walk shows', () => {
    const at = (dx: number, dy: number) => viewOf(facingOf(dx, dy, 's' as Facing));
    expect(at(5, 0)).toEqual({ view: 'e', flip: false });
    expect(at(-5, 0)).toEqual({ view: 'e', flip: true });
    expect(at(0, -5)).toEqual({ view: 'n', flip: false });
    expect(at(0, 5)).toEqual({ view: 's', flip: false });
  });
});

describe('viewTexture', () => {
  it('s is the legacy key; n and e add the view (legs: before the frame)', () => {
    expect(viewTexture('ch-body', 's')).toBe('ch-body');
    expect(viewTexture('ch-body', 'n')).toBe('ch-body-n');
    expect(viewTexture('ch-head', 'e')).toBe('ch-head-e');
    expect(viewTexture('ch-hair-3', 'e')).toBe('ch-hair-3-e');
    expect(viewTexture('ch-legs-sit', 's')).toBe('ch-legs-sit');
    expect(viewTexture('ch-legs-1', 'n')).toBe('ch-legs-n-1');
    expect(viewTexture('ch-legs-sit', 'e')).toBe('ch-legs-e-sit');
  });

  it('every part has a bitmap in every view, with the sizes of docs/design/depth-25d.md 6.1', () => {
    const size = (k: string) => {
      const b = CHARACTER_BITMAPS[k];
      expect(b, k).toBeDefined();
      return [Math.max(...b!.rows.map((r) => r.length)), b!.rows.length] as const;
    };
    const views: View[] = ['s', 'n', 'e'];
    for (const v of views) {
      expect(size(viewTexture('ch-body', v))).toEqual([v === 'e' ? 6 : 8, 6]);
      expect(size(viewTexture('ch-head', v))).toEqual([6, 5]);
      for (const f of ['0', '1', '2']) expect(size(viewTexture(`ch-legs-${f}`, v)), `${v}${f}`).toEqual([v === 'e' ? 6 : 8, 3]);
      if (v !== 's') expect(size(viewTexture('ch-legs-sit', v))).toEqual([v === 'e' ? 6 : 8, 3]);
      for (let i = 0; i < HAIR_STYLES; i++) {
        const [w, h] = size(viewTexture(`ch-hair-${i}`, v));
        expect(w).toBeLessThanOrEqual(6);
        expect(h).toBeLessThanOrEqual(6);
      }
    }
    expect(size('ch-legs-sit')).toEqual([8, 2]);
  });

  it('the profile and back heads differ from the front: no face from behind, one eye in profile', () => {
    const eyes = (k: string) => CHARACTER_BITMAPS[k]!.rows.join('').split('').filter((c) => c === 'e').length;
    expect(eyes('ch-head')).toBe(2);
    expect(eyes('ch-head-n')).toBe(0);
    expect(eyes('ch-head-e')).toBe(1);
  });

  it('rows are rectangular and use only palette chars', () => {
    for (const [k, b] of Object.entries(CHARACTER_BITMAPS)) {
      if (!/^ch-(body|legs|head|hair)/.test(k)) continue;
      const w = b.rows[0]!.length;
      for (const r of b.rows) {
        expect(r.length, k).toBe(w);
        for (const ch of r) if (ch !== ' ') expect(b.palette[ch], `${k} '${ch}'`).toBeDefined();
      }
    }
  });
});

describe('VIEW_OFFSETS', () => {
  it('is complete; s keeps today\'s numbers, n hides badge/prop/face, e has one arm', () => {
    expect(Object.keys(VIEW_OFFSETS).sort()).toEqual(['e', 'n', 's']);
    expect(VIEW_OFFSETS.s).toMatchObject({ badge: true, prop: true, handL: [-4, -4], handR: [4, -4], hatDx: 0, propDx: 0 });
    expect(VIEW_OFFSETS.n).toMatchObject({ badge: false, prop: false, face: false, cloakOver: true });
    expect(VIEW_OFFSETS.e).toMatchObject({ badge: false, prop: true, handL: null, hatDx: 1, propDx: 4 });
    expect(VIEW_OFFSETS.e.handR).not.toBeNull();
  });
});
