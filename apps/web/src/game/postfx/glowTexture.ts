// apps/web/src/game/postfx/glowTexture.ts  (M8 8o.1c: one shared light-glow texture)
//
// Every light source (torch, lantern, desk lamp, console glow, ...) draws the same soft radial
// white circle, tinted per-instance via `Image#setTint` — tint is a per-vertex colour multiply, so
// it doesn't stop same-texture, same-blend-mode sprites from batching into a single draw call (the
// PM's note on this task: no per-light image assets, one generated texture, batch the light layer).
import * as Phaser from 'phaser';

export const LIGHT_GLOW_TEXTURE = 'postfx-light-glow';
/** Reference radius (px) the texture was painted at 1:1 scale for — a light's own `radius` is
 *  applied as `radius / LIGHT_GLOW_REFERENCE_RADIUS` on the sprite. */
export const LIGHT_GLOW_REFERENCE_RADIUS = 32;

const SIZE = LIGHT_GLOW_REFERENCE_RADIUS * 2;

/** Idempotent: safe to call every time the light layer is (re)built. */
export function ensureLightGlowTexture(scene: Phaser.Scene): void {
  if (scene.textures.exists(LIGHT_GLOW_TEXTURE)) return;
  const canvasTexture = scene.textures.createCanvas(LIGHT_GLOW_TEXTURE, SIZE, SIZE);
  if (!canvasTexture) return; // headless/canvas-less test doubles never call this in practice
  const ctx = canvasTexture.getContext();
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, cx);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SIZE, SIZE);
  canvasTexture.refresh();
}
