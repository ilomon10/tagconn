import type * as Phaser from 'phaser';
import type { DecorSlot } from '../../procgen/types';

/** Wall/floor decoration: static art plus the texture keys `theme.decorFor` hands back. */

export const GUILD_TORCH = 'guild-torch';
export const GUILD_GLOW = 'guild-glow';
export const GUILD_WINDOW = 'guild-window';
export const guildBanner = (variant: number): string => `guild-banner-${variant % 3}`;
// Style pass: a more vivid heraldic red (reference art's north-wall banners), keeping the blue
// variant for contrast.
const BANNER_CLOTH = [0xb0202a, 0x1f3a8a, 0xb0202a] as const; // heraldic red, blue, heraldic red
const BANNER_EMBLEM: readonly ('star' | 'key' | 'tower')[] = ['star', 'key', 'tower'];

const MODERN_POSTER = (variant: number): string => `modern-poster-${variant % 2}`;
export const MODERN_WINDOW = 'modern-window';
export const MODERN_CLOCK = 'modern-clock';

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

/** A wall window (style pass): a wood frame, a cross mullion, and a landscape view (sky over
 *  ground) instead of a flat accent square - one more bounded, cached wall-hanging variant. */
function paintWindow(scene: Phaser.Scene, key: string, sky: number, ground: number, frame: number): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(frame, 1);
  g.fillRect(0, 0, 8, 7);
  g.fillStyle(sky, 1);
  g.fillRect(1, 1, 6, 3);
  g.fillStyle(ground, 1);
  g.fillRect(1, 4, 6, 2);
  g.fillStyle(frame, 1);
  g.fillRect(3, 1, 1, 5); // vertical mullion
  g.fillRect(1, 3, 6, 1); // horizontal mullion
  g.generateTexture(key, 8, 7);
  g.destroy();
}

/** A small round wall clock: white face, two hands, a dark rim. */
function paintClock(scene: Phaser.Scene, key: string): void {
  if (scene.textures.exists(key)) return;
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  g.fillStyle(0x2a2e35, 1);
  g.fillCircle(3, 3, 3);
  g.fillStyle(0xf5f0e0, 1);
  g.fillCircle(3, 3, 2);
  g.fillStyle(0x2a2e35, 1);
  g.fillRect(3, 1, 1, 2);
  g.fillRect(3, 3, 2, 1);
  g.generateTexture(key, 6, 6);
  g.destroy();
}

export function paintGuildDecorTextures(scene: Phaser.Scene): void {
  paintTorch(scene);
  paintGlow(scene);
  BANNER_EMBLEM.forEach((shape, i) => paintBannerVariant(scene, guildBanner(i), BANNER_CLOTH[i % BANNER_CLOTH.length]!, shape));
  // An arched, warm-glowing window (reference: "arched windows with warm glow" on the north wall).
  paintWindow(scene, GUILD_WINDOW, 0xffb84a, 0x3a2e1c, 0x2e283c);
}

export function paintModernDecorTextures(scene: Phaser.Scene): void {
  paintPoster(scene, MODERN_POSTER(0), 0x5fb8ff);
  paintPoster(scene, MODERN_POSTER(1), 0x6cf08a);
  // A green landscape window and a wall clock (reference: cream north wall with a window/clock/picture).
  paintWindow(scene, MODERN_WINDOW, 0x8fd0ff, 0x6cf08a, 0x8a5a2b);
  paintClock(scene, MODERN_CLOCK);
}

export function guildDecorFor(slot: DecorSlot): string | null {
  switch (slot.kind) {
    case 'wall-light':
      return GUILD_TORCH;
    case 'wall-hanging':
      // Mostly banners, with a window every 4th slot for wall variety (style pass).
      return slot.variant % 4 === 3 ? GUILD_WINDOW : guildBanner(slot.variant);
    case 'floor-scatter':
      return null;
  }
}

export function modernDecorFor(slot: DecorSlot): string | null {
  switch (slot.kind) {
    case 'wall-hanging':
      // A mix of framed pictures, a landscape window, and a wall clock (style pass).
      switch (slot.variant % 4) {
        case 3:
          return MODERN_CLOCK;
        case 2:
          return MODERN_WINDOW;
        default:
          return MODERN_POSTER(slot.variant);
      }
    case 'wall-light':
    case 'floor-scatter':
      return null;
  }
}
