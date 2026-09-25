import { describe, expect, it } from 'vitest';
import { CLOAK_TEXTURE, GOGGLES_TEXTURE, hatTextureKey, paintCostumeTextures, staffTextureKey } from '../costumes';
import { makeFakeScene } from './testUtils';

describe('paintCostumeTextures', () => {
  it('generates every hat, prop, cloak and goggles texture without throwing', () => {
    const { scene } = makeFakeScene();
    expect(() => paintCostumeTextures(scene)).not.toThrow();
    for (const hat of ['wizard', 'hood', 'crown', 'helm', 'bard-cap', 'circlet'] as const) {
      expect(scene.textures.exists(hatTextureKey(hat))).toBe(true);
    }
    for (const staff of ['staff', 'wand', 'hammer', 'quill', 'lute', 'shield'] as const) {
      expect(scene.textures.exists(staffTextureKey(staff))).toBe(true);
    }
    expect(scene.textures.exists(CLOAK_TEXTURE)).toBe(true);
    expect(scene.textures.exists(GOGGLES_TEXTURE)).toBe(true);
  });

  it('is idempotent (safe to call again on the same scene)', () => {
    const { scene } = makeFakeScene();
    paintCostumeTextures(scene);
    expect(() => paintCostumeTextures(scene)).not.toThrow();
  });
});
