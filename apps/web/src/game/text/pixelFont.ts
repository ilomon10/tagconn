// Atlases for the RPG name plates (docs/design/office-life.md 3.1.2), painted in code like textures.ts.
import type * as Phaser from 'phaser';
import { BIG_CHARS, GLYPHS_3X5, GLYPHS_5X7, SMALL_CHARS } from './glyphs';

export const PIXEL_FONT_KEYS = { big: 'px-font-5x7', small: 'px-font-3x5' } as const;

const CHARS_PER_ROW = 16;

interface FontSpec {
  key: string;
  chars: string;
  glyphs: Readonly<Record<string, readonly string[]>>;
  /** Cell = glyph plus a 1 px gap on the right and bottom, so cell size equals advance and line height. */
  cellW: number;
  cellH: number;
}

const BIG: FontSpec = { key: PIXEL_FONT_KEYS.big, chars: BIG_CHARS, glyphs: GLYPHS_5X7, cellW: 6, cellH: 10 };
const SMALL: FontSpec = { key: PIXEL_FONT_KEYS.small, chars: SMALL_CHARS, glyphs: GLYPHS_3X5, cellW: 4, cellH: 6 };

/** The cache entry Phaser's RetroFont.Parse builds (same shape, same cell math), written out here so this module
 *  never imports the Phaser runtime and stays loadable in node tests. */
function retroEntry(scene: Phaser.Scene, f: FontSpec): Phaser.Types.GameObjects.BitmapText.BitmapFontData {
  const src = scene.textures.getFrame(f.key).source;
  const chars: Record<number, unknown> = {};
  for (let i = 0; i < f.chars.length; i++) {
    const x = (i % CHARS_PER_ROW) * f.cellW;
    const y = Math.floor(i / CHARS_PER_ROW) * f.cellH;
    chars[f.chars.charCodeAt(i)] = {
      x, y, width: f.cellW, height: f.cellH, centerX: Math.floor(f.cellW / 2), centerY: Math.floor(f.cellH / 2),
      xOffset: 0, yOffset: 0, xAdvance: f.cellW, data: {}, kerning: {},
      u0: x / src.width, v0: y / src.height, u1: (x + f.cellW) / src.width, v1: (y + f.cellH) / src.height,
    };
  }
  return { retroFont: true, font: f.key, size: f.cellW, lineHeight: f.cellH, chars } as unknown as
    Phaser.Types.GameObjects.BitmapText.BitmapFontData;
}

function paintFont(scene: Phaser.Scene, f: FontSpec): boolean {
  if (scene.cache.bitmapFont.exists(f.key)) return true;
  if (!scene.textures.exists(f.key)) {
    const rows = Math.ceil(f.chars.length / CHARS_PER_ROW);
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    for (let i = 0; i < f.chars.length; i++) {
      const glyph = f.glyphs[f.chars[i]!];
      if (!glyph) continue;
      const ox = (i % CHARS_PER_ROW) * f.cellW;
      const oy = Math.floor(i / CHARS_PER_ROW) * f.cellH;
      glyph.forEach((row, y) => {
        for (let x = 0; x < row.length; x++) if (row[x] === '#') g.fillRect(ox + x, oy + y, 1, 1);
      });
    }
    g.generateTexture(f.key, CHARS_PER_ROW * f.cellW, rows * f.cellH);
    g.destroy();
  }
  scene.cache.bitmapFont.add(f.key, { data: retroEntry(scene, f), frame: null, texture: f.key });
  return true;
}

/** Paints both atlases (white ink, 1 px cell gap) with Graphics.generateTexture, like textures.ts, and registers
 *  them in the bitmap-font cache (RetroFont layout). Idempotent. False when the cache already failed. */
export function ensurePixelFonts(scene: Phaser.Scene): boolean {
  try {
    return paintFont(scene, BIG) && paintFont(scene, SMALL);
  } catch {
    return false;
  }
}

/** Every char of `text` (after uppercasing for `small`) has a glyph. */
export function hasGlyphs(text: string, size: 'big' | 'small'): boolean {
  const glyphs = size === 'big' ? GLYPHS_5X7 : GLYPHS_3X5;
  const t = size === 'big' ? text : text.toUpperCase();
  for (const ch of t) if (!glyphs[ch]) return false;
  return true;
}
