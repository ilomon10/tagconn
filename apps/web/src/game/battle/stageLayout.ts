// Pure stage geometry for the battle scene (docs/design/battles.md 3.5). Pokémon-style: the enemy stands top-right on a
// platform, the active hero bottom-left. Bench members are not drawn (the HUD shows pips).
export interface Point { x: number; y: number }
export interface Ellipse { cx: number; cy: number; rx: number; ry: number }
export interface Placement { x: number; y: number; scale: number }
export interface StageLayout {
  stageH: number;
  enemy: Placement;
  hero: Placement;
  enemyPlatform: Ellipse;
  heroPlatform: Ellipse;
  dmgAnchor: { enemy: Point; hero: Point };
}

/** Sprite heights in source pixels (hero canvas feet-to-head, enemy art cap), used to keep sprites on screen. */
export const HERO_SPRITE_H = 26;
export const ENEMY_SPRITE_H = 28;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function stageLayout(w: number, h: number, insetBottom: number): StageLayout {
  const stageH = Math.max(1, h - Math.max(0, insetBottom));
  const heroScale = clamp(Math.floor(stageH / 90), 2, 6);
  const enemyY = 0.3 * stageH;
  // +1 for enemies, but never so tall that the head leaves the top edge (feet at `enemyY`).
  const enemyScale = clamp(Math.min(heroScale + 1, Math.floor(enemyY / ENEMY_SPRITE_H)), 1, 7);
  const enemyX = 0.72 * w;
  const heroX = 0.28 * w;
  const heroY = 0.78 * stageH;
  // Platforms stay inside the stage horizontally.
  const rxE = Math.min(14 * enemyScale, enemyX, w - enemyX);
  const rxH = Math.min(14 * heroScale, heroX, w - heroX);
  return {
    stageH,
    enemy: { x: enemyX, y: enemyY, scale: enemyScale },
    hero: { x: heroX, y: heroY, scale: heroScale },
    enemyPlatform: { cx: enemyX, cy: enemyY, rx: rxE, ry: Math.max(2, rxE * 0.3) },
    heroPlatform: { cx: heroX, cy: heroY, rx: rxH, ry: Math.max(2, rxH * 0.3) },
    dmgAnchor: {
      enemy: { x: enemyX, y: enemyY - ENEMY_SPRITE_H * enemyScale * 0.7 },
      hero: { x: heroX, y: heroY - HERO_SPRITE_H * heroScale * 0.7 },
    },
  };
}
