import { describe, expect, it } from 'vitest';
import { makeFakeScene } from '../../themes/__tests__/testUtils';
import { FX_BITMAPS, FX_KEYS, FX_MAX, paintFxTextures } from '../fxArt';

describe('fx art', () => {
  it('has the effect set the scene needs', () => {
    for (const k of ['fx-slash', 'fx-hit', 'fx-crit', 'fx-sparkle', 'fx-heal', 'fx-shield', 'fx-stun', 'fx-merge', 'fx-burnout', 'fx-buff', 'fx-wedge']) expect(FX_KEYS).toContain(k);
  });

  it.each(FX_KEYS)('%s: non-empty, within bounds, palette-only', (k) => {
    const b = FX_BITMAPS[k] as { rows: string[]; palette: Record<string, number> };
    expect(b.rows.length).toBeLessThanOrEqual(FX_MAX);
    let filled = 0;
    for (const r of b.rows) {
      expect(r.length).toBeLessThanOrEqual(FX_MAX);
      for (const ch of r) if (ch !== ' ') { filled++; expect(b.palette[ch], `${k} '${ch}'`).toBeDefined(); }
    }
    expect(filled).toBeGreaterThan(4);
  });

  it('paintFxTextures is idempotent and paints every key', () => {
    const { scene } = makeFakeScene();
    paintFxTextures(scene);
    expect(() => paintFxTextures(scene)).not.toThrow();
    for (const k of FX_KEYS) expect(scene.textures.exists(k)).toBe(true);
  });
});
