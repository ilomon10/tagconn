import type * as Phaser from 'phaser';
import type { DecorSlot } from '../../procgen/types';

/** Wall decoration: a crystal lantern (wall-light) and a rune sigil banner (wall-hanging), in the
 *  rift's cyan/violet palette (docs/design/living-office.md section 6.2). No floor-scatter art,
 *  same as guild and modern. */

export const RIFT_LANTERN = 'rift-lantern';
export const RIFT_GLOW = 'rift-glow';
/** A wide, low, additive-blended strip — one aurora ribbon (section 6.2). */
export const RIFT_AURORA = 'rift-aurora';
export const riftBanner = (variant: number): string => `rift-banner-${variant % 3}`;
const BANNER_CLOTH = [0x241a4a, 0x1a2e4a, 0x241a4a] as const; // deep violet, deep teal, deep violet

function paintLantern(scene: Phaser.Scene): void {
  if (scene.textures.exists(RIFT_LANTERN)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0x2a2350, 1);
  g.fillRect(1, 1, 4, 8);
  g.fillStyle(0x6ff5ff, 0.85);
  g.fillRect(2, 3, 2, 4);
  g.generateTexture(RIFT_LANTERN, 6, 10);
  g.destroy();
}

function paintGlow(scene: Phaser.Scene): void {
  if (scene.textures.exists(RIFT_GLOW)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0x6ff5ff, 1);
  g.fillCircle(20, 20, 20);
  g.generateTexture(RIFT_GLOW, 40, 40);
  g.destroy();
}

function paintBannerVariant(scene: Phaser.Scene, key: string, cloth: number): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(cloth, 1);
  g.fillRect(0, 0, 6, 7);
  g.fillRect(0, 7, 2, 3);
  g.fillRect(4, 7, 2, 3);
  g.fillStyle(0x6ff5ff, 1);
  g.fillRect(2, 2, 2, 1);
  g.fillRect(1, 3, 4, 1);
  g.fillRect(2, 4, 2, 1);
  g.generateTexture(key, 6, 10);
  g.destroy();
}

function paintAurora(scene: Phaser.Scene): void {
  if (scene.textures.exists(RIFT_AURORA)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  // A soft vertical gradient band (a few overlapping translucent bars), wide and short — stretched
  // across the void and additively blended by the caller.
  const bands = [0x6ff5ff, 0x9a6bff, 0x4ff0d0];
  bands.forEach((c, i) => {
    g.fillStyle(c, 0.5);
    g.fillRect(0, i * 4, 64, 6);
  });
  g.generateTexture(RIFT_AURORA, 64, 16);
  g.destroy();
}

export function paintRiftDecorTextures(scene: Phaser.Scene): void {
  paintLantern(scene);
  paintGlow(scene);
  paintAurora(scene);
  BANNER_CLOTH.forEach((cloth, i) => paintBannerVariant(scene, riftBanner(i), cloth));
}

export function riftDecorFor(slot: DecorSlot): string | null {
  switch (slot.kind) {
    case 'wall-light':
      return RIFT_LANTERN;
    case 'wall-hanging':
      return riftBanner(slot.variant);
    case 'floor-scatter':
      return null;
  }
}
