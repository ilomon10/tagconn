import type * as Phaser from 'phaser';

/**
 * Particle/tween helpers shared by world decor (guild.ts `animate()`) and character-attached
 * activity effects (consumed by `actors/Character.ts`). Every creator takes an explicit `enabled`
 * flag — callers compute it once as `office.ambientEffects && !prefersReducedMotion()` — so a
 * disabled call creates a plain, empty container: no tween, no timer, nothing to clean up beyond
 * destroying the container itself.
 *
 * Only a *type* import of `phaser` — the real package touches `window` at module load (device
 * detection), which crashes under vitest's node environment. `DESTROY_EVENT`/`BLEND_ADD` below are
 * the literal values of `Phaser.GameObjects.Events.DESTROY` ('destroy') and `Phaser.BlendModes.ADD`
 * (1), so no runtime import is needed.
 */
const DESTROY_EVENT = 'destroy';
const BLEND_ADD = 1;

/** Safe in both the browser and the node vitest environment (no `window` there). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const FX_DOT = 'fx-dot';
const FX_RING = 'fx-ring';

export function ensureFxTextures(scene: Phaser.Scene): void {
  if (!scene.textures.exists(FX_DOT)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(2, 2, 2);
    g.generateTexture(FX_DOT, 4, 4);
    g.destroy();
  }
  if (!scene.textures.exists(FX_RING)) {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.lineStyle(2, 0xffffff, 1);
    g.strokeCircle(8, 8, 7);
    g.generateTexture(FX_RING, 16, 16);
    g.destroy();
  }
}

/** Kills every tween on `targets` when `container` is destroyed, however the caller destroys it. */
function autoClean(scene: Phaser.Scene, container: Phaser.GameObjects.Container, targets: Phaser.GameObjects.GameObject[]): void {
  container.once(DESTROY_EVENT, () => scene.tweens.killTweensOf(targets));
}

/** Gold sparkles popping above a point, e.g. above the hands while typing, or a `done` burst. */
export function sparkles(scene: Phaser.Scene, x: number, y: number, enabled: boolean, burst = false): Phaser.GameObjects.Container {
  const c = scene.add.container(x, y);
  if (!enabled) return c;
  ensureFxTextures(scene);
  const count = burst ? 8 : 3;
  const dots = Array.from({ length: count }, () => scene.add.image(0, 0, 'icon-sparkle').setScale(0.5).setAlpha(0));
  c.add(dots);
  dots.forEach((d, i) => {
    const angle = burst ? (i / count) * Math.PI * 2 : -Math.PI / 2 + (Math.random() - 0.5) * 0.6;
    const dist = burst ? 8 + Math.random() * 4 : 6;
    scene.tweens.add({
      targets: d,
      x: Math.cos(angle) * dist,
      y: Math.sin(angle) * dist,
      alpha: { from: 0, to: 1 },
      duration: burst ? 500 : 250,
      delay: i * (burst ? 60 : 250),
      repeat: burst ? 0 : -1,
      yoyo: false,
      onComplete: () => d.setAlpha(0),
    });
  });
  autoClean(scene, c, dots);
  return c;
}

/** Green potion bubbles rising and popping, e.g. from a flask prop or a cauldron. */
export function potionBubbles(scene: Phaser.Scene, x: number, y: number, enabled: boolean, color = 0x7ef0a0): Phaser.GameObjects.Container {
  const c = scene.add.container(x, y);
  if (!enabled) return c;
  ensureFxTextures(scene);
  const dots = Array.from({ length: 3 }, () => scene.add.image(0, 0, FX_DOT).setScale(0.4).setTint(color).setAlpha(0));
  c.add(dots);
  dots.forEach((d, i) => {
    scene.tweens.add({
      targets: d,
      y: -10,
      alpha: { from: 0.8, to: 0 },
      duration: 500 + Math.random() * 400,
      delay: i * 350,
      repeat: -1,
      onRepeat: () => d.setPosition((Math.random() - 0.5) * 4, 0),
    });
  });
  autoClean(scene, c, dots);
  return c;
}

/** A small glowing rune ring under the feet that pulses and rotates, e.g. while delegating. */
export function runeGlow(scene: Phaser.Scene, x: number, y: number, enabled: boolean, color = 0x6ff5ff, scale = 0.5): Phaser.GameObjects.Container {
  const c = scene.add.container(x, y);
  if (!enabled) return c;
  ensureFxTextures(scene);
  const ring = scene.add.image(0, 0, FX_RING).setScale(scale).setTint(color).setAlpha(0.6);
  c.add(ring);
  scene.tweens.add({ targets: ring, angle: 360, duration: 4000, repeat: -1 });
  scene.tweens.add({ targets: ring, alpha: { from: 0.3, to: 0.7 }, duration: 700, yoyo: true, repeat: -1 });
  autoClean(scene, c, [ring]);
  return c;
}

/** A ring that grows and fades on a loop, e.g. a channelling aura or a blocked-status flicker. */
export function channelAura(scene: Phaser.Scene, x: number, y: number, enabled: boolean, color = 0xb07aff, scale = 0.3): Phaser.GameObjects.Container {
  const c = scene.add.container(x, y);
  if (!enabled) return c;
  ensureFxTextures(scene);
  const ring = scene.add.image(0, 0, FX_RING).setScale(scale).setTint(color).setAlpha(0.7).setBlendMode(BLEND_ADD);
  c.add(ring);
  scene.tweens.add({ targets: ring, scale: 1.1, alpha: 0, duration: 800, repeat: -1 });
  autoClean(scene, c, [ring]);
  return c;
}

/** Rotating swirl arcs plus motes drifting inward, for a portal-style stairs landing. */
export function portalShimmer(scene: Phaser.Scene, x: number, y: number, enabled: boolean, color: number, scale = 1): Phaser.GameObjects.Container {
  const c = scene.add.container(x, y);
  if (!enabled) return c;
  ensureFxTextures(scene);
  const arcs = Array.from({ length: 3 }, (_, i) =>
    scene.add.image(0, 0, FX_RING).setScale(0.55 * scale, 0.35 * scale).setTint(color).setAlpha(0.5).setAngle(i * 120),
  );
  const motes = Array.from({ length: 4 }, () => scene.add.image(0, 0, FX_DOT).setScale(0.3).setTint(color).setAlpha(0));
  c.add([...arcs, ...motes]);
  scene.tweens.add({ targets: arcs, angle: '+=360', duration: 3000, repeat: -1 });
  const dist = 10 * scale;
  motes.forEach((m, i) => {
    const angle = (i / motes.length) * Math.PI * 2;
    scene.tweens.add({
      targets: m,
      x: 0,
      y: 0,
      alpha: { from: 0.8, to: 0 },
      duration: 900,
      delay: i * 220,
      repeat: -1,
      onRepeat: () => m.setPosition(Math.cos(angle) * dist, Math.sin(angle) * dist).setAlpha(0.8),
    });
    m.setPosition(Math.cos(angle) * dist, Math.sin(angle) * dist);
  });
  autoClean(scene, c, [...arcs, ...motes]);
  return c;
}

/** A torch's flame flicker: scale/alpha jitter at roughly 8Hz. */
export function torchFlicker(scene: Phaser.Scene, flame: Phaser.GameObjects.Image, enabled: boolean): void {
  if (!enabled) return;
  scene.tweens.add({
    targets: flame,
    scaleX: { from: 0.85, to: 1.15 },
    scaleY: { from: 0.9, to: 1.2 },
    alpha: { from: 0.85, to: 1 },
    duration: 110 + Math.random() * 60,
    yoyo: true,
    repeat: -1,
  });
  flame.once(DESTROY_EVENT, () => scene.tweens.killTweensOf(flame));
}

/** Dust/magic motes drifting slowly across the map. ~1 per 60 tiles, capped at 150 by the caller. */
export function ambientMotes(scene: Phaser.Scene, positions: { x: number; y: number }[], enabled: boolean, color: number): Phaser.GameObjects.Container {
  const c = scene.add.container(0, 0);
  if (!enabled) return c;
  ensureFxTextures(scene);
  const dots = positions.map((p) => scene.add.image(p.x, p.y, FX_DOT).setScale(0.25).setTint(color).setAlpha(0.3));
  c.add(dots);
  dots.forEach((d) => {
    scene.tweens.add({
      targets: d,
      x: d.x + (Math.random() - 0.5) * 12,
      y: d.y + (Math.random() - 0.5) * 12,
      duration: 4000 + Math.random() * 3000,
      yoyo: true,
      repeat: -1,
    });
  });
  autoClean(scene, c, dots);
  return c;
}

/** Dispatches `ThemeDefinition.activityFx` kinds to the matching helper (used by `Character.ts`). */
export function createActivityFx(
  scene: Phaser.Scene,
  kind: 'sparkles' | 'bubbles' | 'rune' | 'channel' | 'none' | undefined,
  x: number,
  y: number,
  enabled: boolean,
): Phaser.GameObjects.Container {
  switch (kind) {
    case 'sparkles':
      return sparkles(scene, x, y, enabled);
    case 'bubbles':
      return potionBubbles(scene, x, y, enabled);
    case 'rune':
      return runeGlow(scene, x, y, enabled);
    case 'channel':
      return channelAura(scene, x, y, enabled);
    default:
      return scene.add.container(x, y);
  }
}
