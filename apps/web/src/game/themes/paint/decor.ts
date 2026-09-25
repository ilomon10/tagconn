import type * as Phaser from 'phaser';
import type { DecorSlot } from '../../procgen/types';

/** Wall/floor decoration: static art plus the texture keys `theme.decorFor` hands back. */

export const GUILD_TORCH = 'guild-torch';
export const GUILD_GLOW = 'guild-glow';
export const guildBanner = (variant: number): string => `guild-banner-${variant % 3}`;
const BANNER_CLOTH = [0x8a1f2b, 0x1f3a8a, 0x8a1f2b] as const; // crimson, blue, crimson
const BANNER_EMBLEM: readonly ('star' | 'key' | 'tower')[] = ['star', 'key', 'tower'];

const MODERN_POSTER = (variant: number): string => `modern-poster-${variant % 2}`;

function paintTorch(scene: Phaser.Scene): void {
  if (scene.textures.exists(GUILD_TORCH)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0x1c1c22, 1);
  g.fillRect(1, 2, 4, 2);
  g.fillStyle(0x2a2a33, 1);
  g.fillRect(2, 3, 2, 9);
  g.generateTexture(GUILD_TORCH, 6, 12);
  g.destroy();
}

function paintGlow(scene: Phaser.Scene): void {
  if (scene.textures.exists(GUILD_GLOW)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0xffb84a, 1);
  g.fillCircle(20, 20, 20);
  g.generateTexture(GUILD_GLOW, 40, 40);
  g.destroy();
}

function paintBannerVariant(scene: Phaser.Scene, key: string, cloth: number, shape: 'star' | 'key' | 'tower'): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(cloth, 1);
  g.fillRect(0, 0, 6, 7);
  g.fillRect(0, 7, 2, 3); // notched bottom: two flaps with a gap between
  g.fillRect(4, 7, 2, 3);
  const gold = 0xe8c070;
  g.fillStyle(gold, 1);
  if (shape === 'star') {
    g.fillRect(2, 2, 2, 1);
    g.fillRect(1, 3, 4, 1);
    g.fillRect(2, 4, 2, 1);
  } else if (shape === 'key') {
    g.fillCircle(3, 2, 1);
    g.fillRect(3, 3, 1, 3);
    g.fillRect(3, 5, 2, 1);
  } else {
    g.fillRect(2, 1, 2, 5);
    g.fillRect(1, 1, 4, 1);
  }
  g.generateTexture(key, 6, 10);
  g.destroy();
}

function paintPoster(scene: Phaser.Scene, key: string, accent: number): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0x1b1e26, 1);
  g.fillRect(0, 0, 8, 6);
  g.fillStyle(accent, 1);
  g.fillRect(1, 1, 6, 4);
  g.generateTexture(key, 8, 6);
  g.destroy();
}

export function paintGuildDecorTextures(scene: Phaser.Scene): void {
  paintTorch(scene);
  paintGlow(scene);
  BANNER_EMBLEM.forEach((shape, i) => paintBannerVariant(scene, guildBanner(i), BANNER_CLOTH[i % BANNER_CLOTH.length]!, shape));
}

export function paintModernDecorTextures(scene: Phaser.Scene): void {
  paintPoster(scene, MODERN_POSTER(0), 0x5fb8ff);
  paintPoster(scene, MODERN_POSTER(1), 0x6cf08a);
}

export function guildDecorFor(slot: DecorSlot): string | null {
  switch (slot.kind) {
    case 'wall-light':
      return GUILD_TORCH;
    case 'wall-hanging':
      return guildBanner(slot.variant);
    case 'floor-scatter':
      return null;
  }
}

export function modernDecorFor(slot: DecorSlot): string | null {
  switch (slot.kind) {
    case 'wall-hanging':
      return MODERN_POSTER(slot.variant);
    case 'wall-light':
    case 'floor-scatter':
      return null;
  }
}
