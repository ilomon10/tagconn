// STUB (W0b): W1-1 owns the body. Until then Character falls back to Phaser `Text`.
import type * as Phaser from 'phaser';

export const PIXEL_FONT_KEYS = { big: 'px-font-5x7', small: 'px-font-3x5' } as const;

/** Paints both atlases (white ink, 1 px cell gap) with Graphics.generateTexture, like textures.ts, and registers
 *  them with Phaser.GameObjects.RetroFont.Parse. Idempotent. False when the cache already failed. */
export function ensurePixelFonts(_scene: Phaser.Scene): boolean {
  return false;
}

/** Every char of `text` (after uppercasing for `small`) has a glyph. */
export function hasGlyphs(_text: string, _size: 'big' | 'small'): boolean {
  return false;
}
