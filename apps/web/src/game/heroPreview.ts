import type { HeroAppearance } from '@tagconn/shared';
import { resolveHeroCostume } from './heroLook';
import { CHARACTER_BITMAPS, type Bitmap } from './textures';
import { CLOAK_BITMAP, GOGGLES_BITMAP, HAT_BITMAPS, STAFF_BITMAPS } from './themes/costumes';
import type { Costume } from './themes/types';

/**
 * A plain 2D-canvas painter over the same tiny-ASCII bitmaps `Character` draws with Phaser
 * (`../actors/Character.ts`), for the hero editor's live preview (docs/design/living-office.md
 * section 3.4: "a 2D canvas painter over the same ASCII bitmaps ... so it needs no Phaser").
 * `resolveHeroCostume` (`heroLook.ts`) does the appearance → draw-parameters resolution; this
 * module only replicates `Character`'s layering and tinting on `ctx`.
 */

export interface HeroPreviewOptions {
  appearance: HeroAppearance;
  /** The active theme's costume for this hero's role (`resolveCostume(theme, role)`). */
  themeCostume: Costume;
  roleColor: number;
  /** Pixels drawn per bitmap pixel (the editor renders at 6x). Defaults to 1. */
  scale?: number;
  /** Canvas-space feet position. Defaults to a frame centered at (16, 22) * scale. */
  originX?: number;
  originY?: number;
}

interface Part {
  bitmap: Bitmap;
  /** Bitmap-pixel offset from the feet, same convention as `Character`'s local image positions. */
  x: number;
  y: number;
  /** Anchor within the bitmap, `Phaser.GameObjects.Image` origin convention (0..1 per axis). */
  anchorX: number;
  anchorY: number;
  tint?: number;
  alpha?: number;
}

function tintChannel(base: number, tint: number): number {
  return Math.round((base / 255) * tint);
}

/** Multiplies a (mostly white/grey) bitmap pixel by a tint colour, like `Image.setTint`. */
function tintPixel(base: number, tint: number): number {
  const br = (base >> 16) & 0xff;
  const bg = (base >> 8) & 0xff;
  const bb = base & 0xff;
  const tr = (tint >> 16) & 0xff;
  const tg = (tint >> 8) & 0xff;
  const tb = tint & 0xff;
  return (tintChannel(br, tr) << 16) | (tintChannel(bg, tg) << 8) | tintChannel(bb, tb);
}

function blit(ctx: CanvasRenderingContext2D, part: Part, scale: number, originX: number, originY: number): void {
  const rows = part.bitmap.rows;
  const w = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const h = rows.length;
  const left = originX + (part.x - part.anchorX * w) * scale;
  const top = originY + (part.y - part.anchorY * h) * scale;
  ctx.save();
  if (part.alpha !== undefined) ctx.globalAlpha = part.alpha;
  for (let y = 0; y < h; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      if (ch === ' ') continue;
      const base = part.bitmap.palette[ch];
      if (base === undefined) continue;
      const color = part.tint !== undefined ? tintPixel(base, part.tint) : base;
      ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      ctx.fillRect(left + x * scale, top + y * scale, scale, scale);
    }
  }
  ctx.restore();
}

/**
 * Paints one hero at `opts.scale` pixels per bitmap pixel onto `ctx`, in `Character`'s layer order
 * (shadow, legs, cloak, body, head, hair, hat, goggles, prop). The tiny badge and hand squares are
 * skipped — they carry no hero-appearance information (a live "unread" indicator and a fixed
 * skin-toned dot), so they'd add drawing without adding anything the editor lets you customize.
 */
export function paintHeroPreview(ctx: CanvasRenderingContext2D, opts: HeroPreviewOptions): void {
  const scale = opts.scale ?? 1;
  const originX = opts.originX ?? 16 * scale;
  const originY = opts.originY ?? 22 * scale;
  const { costume, skin, hair, hairStyle, outfit } = resolveHeroCostume(opts.themeCostume, opts.appearance, opts.roleColor);

  const parts: Part[] = [
    { bitmap: CHARACTER_BITMAPS['ch-shadow']!, x: 0, y: 1, anchorX: 0.5, anchorY: 1, alpha: 0.28 },
    { bitmap: CHARACTER_BITMAPS['ch-legs-0']!, x: 0, y: 0, anchorX: 0.5, anchorY: 1 },
  ];
  if (costume.cloak !== undefined) parts.push({ bitmap: CLOAK_BITMAP, x: 0, y: -2, anchorX: 0.5, anchorY: 1, tint: costume.cloak });
  parts.push(
    { bitmap: CHARACTER_BITMAPS['ch-body']!, x: 0, y: -3, anchorX: 0.5, anchorY: 1, tint: outfit },
    { bitmap: CHARACTER_BITMAPS['ch-head']!, x: 0, y: -9, anchorX: 0.5, anchorY: 1, tint: skin },
    { bitmap: CHARACTER_BITMAPS[`ch-hair-${hairStyle}`]!, x: 0, y: -15, anchorX: 0.5, anchorY: 0, tint: hair },
  );
  if (costume.hat && costume.hat !== 'none') {
    const bitmap = HAT_BITMAPS[costume.hat];
    if (bitmap) parts.push({ bitmap, x: 0, y: -15, anchorX: 0.5, anchorY: 1, tint: costume.hatColor ?? outfit });
  }
  if (costume.goggles) parts.push({ bitmap: GOGGLES_BITMAP, x: 0, y: -12, anchorX: 0.5, anchorY: 0.5 });
  if (costume.staff && costume.staff !== 'none') {
    const bitmap = STAFF_BITMAPS[costume.staff];
    if (bitmap) parts.push({ bitmap, x: 0, y: -3, anchorX: 0.5, anchorY: 1 });
  }

  for (const part of parts) blit(ctx, part, scale, originX, originY);
}
