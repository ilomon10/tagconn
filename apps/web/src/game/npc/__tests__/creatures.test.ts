import { describe, expect, it } from 'vitest';
import { makeFakeScene } from '../../themes/__tests__/testUtils';
import { CREATURE_BITMAPS, CREATURE_MAX_H, CREATURE_MAX_W, paintCreatureTextures } from '../creatures';
import { creatureTextureKey } from '../types';

const IDS = ['dog', 'cat', 'monster', 'wolf', 'familiar', 'slime', 'hover-hound', 'astro-cat', 'void-blob'] as const;

describe('CREATURE_BITMAPS', () => {
  it('has exactly the CreatureIds', () => {
    expect(Object.keys(CREATURE_BITMAPS).sort()).toEqual([...IDS].sort());
  });

  it.each(IDS)('%s: two frames within 14x10, only palette colours, feet on the bottom row', (id) => {
    const frames = CREATURE_BITMAPS[id];
    expect(frames).toHaveLength(2);
    for (const f of frames) {
      expect(f.rows.length).toBeGreaterThan(0);
      expect(f.rows.length).toBeLessThanOrEqual(CREATURE_MAX_H);
      for (const r of f.rows) {
        expect(r.length).toBeLessThanOrEqual(CREATURE_MAX_W);
        for (const ch of r) if (ch !== ' ') expect(f.palette[ch], `${id} char "${ch}"`).toBeDefined();
      }
      expect(f.rows[f.rows.length - 1]!.trim().length).toBeGreaterThan(0);
    }
    expect(frames[0].rows.join('\n')).not.toEqual(frames[1].rows.join('\n'));
  });
});

describe('paintCreatureTextures', () => {
  it('paints both frames of every creature, idempotently', () => {
    const { scene } = makeFakeScene();
    paintCreatureTextures(scene);
    expect(() => paintCreatureTextures(scene)).not.toThrow();
    for (const id of IDS) for (const f of [0, 1] as const) expect(scene.textures.exists(creatureTextureKey(id, f))).toBe(true);
  });
});
