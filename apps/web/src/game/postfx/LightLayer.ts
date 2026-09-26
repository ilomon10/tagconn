// apps/web/src/game/postfx/LightLayer.ts  (M8 8o.1c: bloom light layer)
//
// One `Container` holding every light source's glow sprite — all sharing the single generated
// `LIGHT_GLOW_TEXTURE` (see `glowTexture.ts`) with a per-instance tint and additive blend, so they
// batch into a single draw call regardless of count. An optional `Bloom` postFX pass is attached to
// the *container as a whole* (never to individual sprites, never to the base art), which is the
// "cheap approach" requirement 8o.1c asks for: blur/bloom only this layer, one extra pass total.
import * as Phaser from 'phaser';
import { ensureLightGlowTexture, LIGHT_GLOW_REFERENCE_RADIUS, LIGHT_GLOW_TEXTURE } from './glowTexture';
import type { LightSource, ShaderQuality } from './types';

const FLICKER_MIN_MS = 90;
const FLICKER_MAX_MS = 160;

export class LightLayer {
  private container: Phaser.GameObjects.Container;
  private sprites: Phaser.GameObjects.Image[] = [];

  constructor(
    private scene: Phaser.Scene,
    depth: number,
  ) {
    ensureLightGlowTexture(scene);
    this.container = scene.add.container(0, 0).setDepth(depth);
  }

  /** Rebuilds the glow sprites for this frame's light sources (map rebuild/reskin only, not
   *  per-frame) — pass `[]` when `office.shaders.lightGlow` is off so no sprites exist at all. */
  setLights(lights: readonly LightSource[], reducedMotion: boolean): void {
    for (const s of this.sprites) s.destroy();
    this.sprites = lights.map((light) => this.makeSprite(light, reducedMotion));
  }

  private makeSprite(light: LightSource, reducedMotion: boolean): Phaser.GameObjects.Image {
    const scale = light.radius / LIGHT_GLOW_REFERENCE_RADIUS;
    const img = this.scene.add
      .image(light.x, light.y, LIGHT_GLOW_TEXTURE)
      .setScale(scale)
      .setTint(light.color)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.5);
    this.container.add(img);
    if (light.flicker && !reducedMotion) {
      this.scene.tweens.add({
        targets: img,
        alpha: { from: 0.35, to: 0.6 },
        scale: { from: scale * 0.9, to: scale * 1.1 },
        duration: FLICKER_MIN_MS + Math.random() * (FLICKER_MAX_MS - FLICKER_MIN_MS),
        yoyo: true,
        repeat: -1,
      });
    }
    return img;
  }

  /** `strength` is `office.shaders.bloom` (0..1), already zeroed by the caller when `lightGlow` is
   *  off. `'low'` quality skips the blur pass outright ("no blur passes" — requirement 8o.3) even
   *  when `strength > 0`; the plain additive glow sprites still draw. */
  setBloom(strength: number, quality: ShaderQuality): void {
    this.container.postFX?.clear();
    if (strength <= 0 || quality === 'low') return;
    this.container.postFX?.addBloom(0xffffff, 0, 0, 1 + strength, 0.6 + strength * 0.8, 2);
  }

  destroy(): void {
    for (const s of this.sprites) s.destroy();
    this.sprites = [];
    this.container.destroy();
  }
}
