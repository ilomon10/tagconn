import type * as Phaser from 'phaser';

/**
 * All art is generated at runtime from tiny ASCII bitmaps — no asset files.
 * White/grey pixels are meant to be tinted (shirt = role color, hair, skin).
 */

type Palette = Record<string, number>;

interface Bitmap {
  rows: string[];
  palette: Palette;
  /** Auto-outline empty pixels touching filled ones with this color. */
  outline?: number;
}

const W = 0xffffff;
const SHADE = 0xc9c9c9;
const DARK_SHADE = 0x9a9a9a;

export const HAIR_COLORS = [0x3b2a20, 0x16110f, 0xd6a852, 0x8d3b1f, 0x8a8a8a, 0x6a4a9a, 0x2f4f6f];
export const SKIN_TONES = [0xf5c89a, 0xe3ab7c, 0xc08457, 0x8d5a36, 0xffe0bd];

const bitmaps: Record<string, Bitmap> = {
  'ch-body': {
    rows: [' wwwwww ', 'wwwwwwww', 'swwwwwws', 'swwwwwws', 'swwwwwws', ' ssssss '],
    palette: { w: W, s: SHADE },
  },
  'ch-legs-0': { rows: [' pp  pp ', ' pp  pp ', ' kk  kk '], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-legs-1': { rows: [' pp  pp ', ' kk  pp ', '     kk '], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-legs-2': { rows: [' pp  pp ', ' pp  kk ', ' kk     '], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-legs-sit': { rows: [' pppppp ', ' kk  kk '], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-head': { rows: [' ffff ', 'ffffff', 'fekfek', 'ffffff', ' fssf '], palette: { f: W, e: 0x2b2330, k: W, s: SHADE } },
  'ch-hair-0': { rows: [' hhhh ', 'hhhhhh', 'h    h'], palette: { h: W } },
  'ch-hair-1': { rows: [' hhhh ', 'hhhhhh', 'hh  hh', 'h    h', 'h    h', 'h    h'], palette: { h: W } },
  'ch-hair-2': { rows: ['h hh h', 'hhhhhh', 'h    h'], palette: { h: W } },
  'ch-hair-3': { rows: ['  hh  ', ' hhhh ', 'hhhhhh', 'h    h'], palette: { h: W } },
  'ch-hair-4': { rows: [' hhhhh', 'hhhhhh', 'hhh   '], palette: { h: W } },
  'ch-hair-5': { rows: ['      ', ' h  h '], palette: { h: W } },
  'ch-hair-6': { rows: [' hhhh ', 'hhhhhh', 'hh  hh', 'h    h', 'hh  hh'], palette: { h: W } },
  'ch-shadow': { rows: [' ssssssss ', 'ssssssssss', ' ssssssss '], palette: { s: 0x000000 } },
  'ch-badge': { rows: ['ww', 'wd'], palette: { w: W, d: DARK_SHADE } },
  px: { rows: ['ww', 'ww'], palette: { w: W } },

  'prop-laptop': { rows: ['sssssss', 'sbbbbbs', 'ggggggg', ' ggggg '], palette: { s: 0x55596b, b: 0x8fd3ff, g: 0x3b3f4e } },
  'prop-terminal': { rows: ['sssssss', 'sgbbbbs', 'sbbgbbs', 'ggggggg'], palette: { s: 0x55596b, b: 0x162028, g: 0x6cf08a } },
  'prop-book': { rows: ['rr rr', 'pp pp', 'pp pp', 'rrrrr'], palette: { r: 0xb5433a, p: 0xf2ead3 } },
  'prop-magnifier': { rows: [' mmm  ', 'mbbbm ', 'mbbbm ', ' mmmw ', '    ww'], palette: { m: 0xd9d9d9, b: 0x9fd8ff, w: 0x8a5a2b } },
  'prop-flask': { rows: [' ggg ', '  g  ', ' g g ', 'gllgg', 'lllll', ' lll '], palette: { g: 0xd9eef7, l: 0x7ef0a0 } },
  'prop-clipboard': { rows: [' bb ', 'wwww', 'wkkw', 'wwww', 'wkkw'], palette: { b: 0x8a5a2b, w: 0xf5f5f5, k: 0x666666 } },
  'prop-globe': { rows: [' bbb ', 'bggbb', 'bbggb', 'bgbbb', ' bbb '], palette: { b: 0x4a90e2, g: 0x7ed321 } },
  'prop-cup': { rows: ['www ', 'wwwk', 'www '], palette: { w: 0xf5f5f5, k: 0xdddddd } },

  'icon-question': { rows: [' yyy ', 'y   y', '    y', '   y ', '  y  ', '     ', '  y  '], palette: { y: 0xffd84a }, outline: 0x241c10 },
  'icon-bang': { rows: ['rr', 'rr', 'rr', 'rr', '  ', 'rr'], palette: { r: 0xff4a4a }, outline: 0x2a0808 },
  'icon-dots-1': { rows: ['ww      ', 'ww      '], palette: { w: 0xf2ecff }, outline: 0x1c1826 },
  'icon-dots-2': { rows: ['ww ww   ', 'ww ww   '], palette: { w: 0xf2ecff }, outline: 0x1c1826 },
  'icon-dots-3': { rows: ['ww ww ww', 'ww ww ww'], palette: { w: 0xf2ecff }, outline: 0x1c1826 },
  'icon-sparkle': { rows: ['  y  ', '  y  ', 'yyyyy', '  y  ', '  y  '], palette: { y: 0xfff3a0 }, outline: 0x2a2410 },
  'icon-arrow': { rows: ['   o  ', '   oo ', 'oooooo', '   oo ', '   o  '], palette: { o: 0xffa94a }, outline: 0x2a1808 },
  'icon-zz': { rows: ['zzzz', '  z ', ' z  ', 'zzzz'], palette: { z: 0x9fc8ff }, outline: 0x10182a },
  'icon-check': { rows: ['     g', '    gg', 'g  gg ', 'ggggg ', ' gg   '], palette: { g: 0x6cf08a }, outline: 0x0a2410 },
  'icon-term': { rows: ['g   ', ' g  ', 'g ww'], palette: { g: 0x6cf08a, w: 0xf2ecff }, outline: 0x0a1410 },
};

function withOutline(b: Bitmap): string[] {
  if (b.outline === undefined) return b.rows;
  const h = b.rows.length + 2;
  const w = Math.max(...b.rows.map((r) => r.length)) + 2;
  const at = (x: number, y: number) => {
    const ch = b.rows[y - 1]?.[x - 1];
    return ch !== undefined && ch !== ' ';
  };
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      if (at(x, y)) row += b.rows[y - 1]![x - 1]!;
      else {
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) near = at(x + dx, y + dy);
        row += near ? '#' : ' ';
      }
    }
    out.push(row);
  }
  return out;
}

export function paintBitmap(scene: Phaser.Scene, key: string, b: Bitmap) {
  if (scene.textures.exists(key)) return;
  const rows = withOutline(b);
  const palette: Palette = { ...b.palette, ...(b.outline !== undefined ? { '#': b.outline } : {}) };
  const g = scene.make.graphics({ x: 0, y: 0 }, false);
  const w = Math.max(...rows.map((r) => r.length));
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = palette[row[x]!];
      if (c === undefined) continue;
      g.fillStyle(c, key === 'ch-shadow' ? 0.28 : 1);
      g.fillRect(x, y, 1, 1);
    }
  });
  g.generateTexture(key, w, rows.length);
  g.destroy();
}

export function generateTextures(scene: Phaser.Scene) {
  for (const [key, b] of Object.entries(bitmaps)) paintBitmap(scene, key, b);
}

export const HAIR_STYLES = 7;
