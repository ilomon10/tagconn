import type * as Phaser from 'phaser';
import type { BattleNpcKind } from '@tagconn/shared';
import { CREATURE_BITMAPS } from '../npc/creatures';
import type { CreatureId } from '../themes/types';
import type { Bitmap } from '../textures';
import { paintBitmap, withOutline } from '../textures';
import type { BattleStyle } from './types';

/**
 * Battle enemy art (M14 A1, ADR #22: code-drawn, no asset files). Every enemy kind has 2 frames per
 * style (modern / guild / rift). Creatures reuse the NPC creature bitmaps at 2x; the costumed humans
 * (guest, police, cia-agent) are bigger front-facing sprites with a per-style palette. Frame 1 is the
 * idle frame (step / arm swing). Colours are baked in (never tinted).
 */

export const ENEMY_KINDS = ['guest', 'police', 'cia-agent', 'sales-dog', 'monster', 'office-cat'] as const satisfies readonly BattleNpcKind[];
export const BATTLE_STYLES = ['modern', 'guild', 'rift'] as const satisfies readonly BattleStyle[];
/** Largest painted sprite (px, including the outline). Humans are 14x19; 2x creatures are 28x20 + outline. */
export const ENEMY_MAX_W = 32;
export const ENEMY_MAX_H = 24;

export const enemyTextureKey = (kind: BattleNpcKind, style: BattleStyle, frame: 0 | 1): string => `enemy-${kind}-${style}-${frame}`;

const CREATURE_OF: Record<'sales-dog' | 'monster' | 'office-cat', Record<BattleStyle, CreatureId>> = {
  'sales-dog': { modern: 'dog', guild: 'wolf', rift: 'hover-hound' },
  monster: { modern: 'monster', guild: 'slime', rift: 'void-blob' },
  'office-cat': { modern: 'cat', guild: 'familiar', rift: 'astro-cat' },
};
const OUTLINE: Record<BattleStyle, number> = { modern: 0x1c1418, guild: 0x24160c, rift: 0x0c0820 };

/** 2x nearest-neighbour; `w` pads every row so both frames of a creature share one width. */
const upscale2 = (b: Bitmap, outline: number, w: number): Bitmap => ({
  palette: b.palette,
  outline,
  rows: b.rows.flatMap((r) => {
    const wide = [...r.padEnd(w)].map((c) => c + c).join('');
    return [wide, wide];
  }),
});

/*
 * Human template, 12 columns. Keys: h hair/hat, f skin, k eyes, t torso, a sleeves, l legs, d shoes,
 * y accent (badge / tie / belt), s shades, c brim / collar. Frame 1 steps the legs and swings the arms.
 */
type HumanPal = Record<string, number>;
const HEAD_GUEST = ['   hhhhhh   ', '  hhhhhhhh  ', '  hffffffh  ', '  fffkfkff  ', '  ffffffff  ', '   ffmmff   '];
const HEAD_POLICE = ['   cccccc   ', '  hhhyyhhh  ', '  hffffffh  ', '  fffkfkff  ', '  ffffffff  ', '   ffmmff   '];
const HEAD_CIA = ['   hhhhhh   ', ' cccccccccc ', '  hffffffh  ', '  ssssssss  ', '  ffffffff  ', '   ffmmff   '];
const BODY_A = ['  aattttaa  ', ' aattyytaaf ', ' aatttttaaf ', ' fattttttaf ', '   tttttt   ', '   tttttt   ', '   yyyyyy   '];
const BODY_B = ['  aattttaa  ', ' aattyytaa  ', ' fatttttaaf ', '  attttttaf ', '   tttttt   ', '   tttttt   ', '   yyyyyy   '];
const LEGS_A = ['   lll lll  ', '   lll lll  ', '   lll lll  ', '   ddd ddd  '];
const LEGS_B = ['   lll lll  ', '   lll  ll  ', '   ll   lll ', '   dd   ddd '];

const HUMANS: Record<'guest' | 'police' | 'cia-agent', { head: string[]; pal: Record<BattleStyle, HumanPal> }> = {
  guest: {
    head: HEAD_GUEST,
    pal: {
      modern: { h: 0x5a3a24, f: 0xf0c39a, k: 0x1c1418, m: 0xc9705a, t: 0x4fa8d8, a: 0x3a86b4, y: 0xf2ead3, l: 0x3b4a6b, d: 0x1c1418 },
      guild: { h: 0x8a4a22, f: 0xe8b88a, k: 0x241408, m: 0xb86a4a, t: 0x6a9a3a, a: 0x4a7a2a, y: 0x8a5a2b, l: 0x5a4030, d: 0x2a1a0c },
      rift: { h: 0x6ad8ff, f: 0xb8e0e8, k: 0x0c1830, m: 0x6a8aa8, t: 0xd8e4f4, a: 0x8a9ab8, y: 0x4fe3ff, l: 0x3a3a6a, d: 0x14143a },
    },
  },
  police: {
    head: HEAD_POLICE,
    pal: {
      modern: { c: 0x23305a, h: 0x23305a, y: 0xffd84a, f: 0xf0c39a, k: 0x1c1418, m: 0xc9705a, t: 0x2f4a8a, a: 0x23386e, l: 0x1f2a4a, d: 0x0c0c14 },
      guild: { c: 0x8a93a6, h: 0x6a7388, y: 0xffd84a, f: 0xe8b88a, k: 0x241408, m: 0xb86a4a, t: 0x3a5aa8, a: 0x5a6378, l: 0x4a4a58, d: 0x1c1a20 },
      rift: { c: 0x2a2f6a, h: 0x4a4fd8, y: 0x4fe3ff, f: 0xc0d8e8, k: 0x0c0820, m: 0x6a7a98, t: 0x3a3fa8, a: 0x2a2f78, l: 0x1c1f48, d: 0x0c0820 },
    },
  },
  'cia-agent': {
    head: HEAD_CIA,
    pal: {
      modern: { h: 0x15151c, c: 0x2a2a36, s: 0x0c0c12, f: 0xf0c39a, m: 0xb8604a, t: 0x30303a, a: 0x20202a, y: 0xd9534f, l: 0x20202a, d: 0x0c0c12, k: 0x000000 },
      guild: { h: 0x2a1a24, c: 0x4a2a4a, s: 0x120a14, f: 0xe8b88a, m: 0xb0604a, t: 0x4a2c52, a: 0x35203c, y: 0xc9a43a, l: 0x35203c, d: 0x120a14, k: 0x000000 },
      rift: { h: 0x0c1020, c: 0x1f2a4a, s: 0x4fe3ff, f: 0xa8d0e0, m: 0x5a7a98, t: 0x1c2440, a: 0x141a30, y: 0xff5aa0, l: 0x141a30, d: 0x08091a, k: 0x000000 },
    },
  },
};

const humanBitmaps = (kind: 'guest' | 'police' | 'cia-agent', style: BattleStyle): readonly [Bitmap, Bitmap] => {
  const def = HUMANS[kind];
  const mk = (body: string[], legs: string[]): Bitmap => ({ palette: def.pal[style], outline: OUTLINE[style], rows: [...def.head, ...body, ...legs] });
  return [mk(BODY_A, LEGS_A), mk(BODY_B, LEGS_B)];
};

const cache = new Map<string, readonly [Bitmap, Bitmap]>();

/** The two raw frames of an enemy for a style (cached; used by the texture and the canvas painters and tests). */
export function enemyBitmaps(kind: BattleNpcKind, style: BattleStyle): readonly [Bitmap, Bitmap] {
  const id = `${kind}/${style}`;
  let hit = cache.get(id);
  if (!hit) {
    if (kind === 'guest' || kind === 'police' || kind === 'cia-agent') hit = humanBitmaps(kind, style);
    else {
      const f = CREATURE_BITMAPS[CREATURE_OF[kind][style]];
      const w = Math.max(...f.flatMap((b) => b.rows.map((r) => r.length)));
      hit = [upscale2(f[0], OUTLINE[style], w), upscale2(f[1], OUTLINE[style], w)];
    }
    cache.set(id, hit);
  }
  return hit;
}

/** Pixel size (with the outline) of an enemy sprite; the frames of one enemy share it. */
export function enemySize(kind: BattleNpcKind, style: BattleStyle): { w: number; h: number } {
  const rows = withOutline(enemyBitmaps(kind, style)[0]);
  return { w: Math.max(...rows.map((r) => r.length)), h: rows.length };
}

/** Paints both frames as textures `enemy-<kind>-<style>-0|1` (idempotent through `paintBitmap`). */
export function paintEnemyTexture(scene: Phaser.Scene, kind: BattleNpcKind, style: BattleStyle): string {
  const frames = enemyBitmaps(kind, style);
  paintBitmap(scene, enemyTextureKey(kind, style, 0), frames[0]);
  paintBitmap(scene, enemyTextureKey(kind, style, 1), frames[1]);
  return enemyTextureKey(kind, style, 0);
}

/**
 * Draws frame 0 onto a 2D canvas at (0, 0), `scale` canvas px per art pixel (the encounter alert
 * portrait). Returns the drawn size in canvas px so the caller can size the canvas.
 */
export function paintEnemyCanvas(
  ctx: Pick<CanvasRenderingContext2D, 'fillStyle' | 'fillRect'>,
  kind: BattleNpcKind,
  style: BattleStyle,
  scale: number,
): { w: number; h: number } {
  const b = enemyBitmaps(kind, style)[0];
  const rows = withOutline(b);
  const palette: Record<string, number> = { ...b.palette, ...(b.outline !== undefined ? { '#': b.outline } : {}) };
  const s = Math.max(1, Math.floor(scale));
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = palette[row[x]!];
      if (c === undefined) continue;
      ctx.fillStyle = `#${c.toString(16).padStart(6, '0')}`;
      ctx.fillRect(x * s, y * s, s, s);
    }
  });
  const size = enemySize(kind, style);
  return { w: size.w * s, h: size.h * s };
}
