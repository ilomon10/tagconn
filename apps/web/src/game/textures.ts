import type * as Phaser from 'phaser';
import type { View } from './actors/walkQueue';
import { HERO_HAIR_COLORS, HERO_HAIR_STYLE_COUNT, HERO_SKIN_TONES } from '@tagconn/shared';

/**
 * All art is generated at runtime from tiny ASCII bitmaps — no asset files.
 * White/grey pixels are meant to be tinted (shirt = role color, hair, skin).
 */

export type Palette = Record<string, number>;

export interface Bitmap {
  rows: string[];
  palette: Palette;
  /** Auto-outline empty pixels touching filled ones with this color. */
  outline?: number;
}

const W = 0xffffff;
const SHADE = 0xc9c9c9;
const DARK_SHADE = 0x9a9a9a;

/** `#rrggbb` (as stored on `HeroAppearance`) to a Phaser/canvas tint number. */
export function hexToNumber(hex: string): number {
  return parseInt(hex.slice(1), 16);
}

// Derived from the shared vocabulary (packages/shared/src/heroes.ts) rather than duplicated, so
// the web palette can never drift from `HERO_HAIR_COLORS` / `HERO_SKIN_TONES` (W4 acceptance: the
// values stay equal to `HERO_*`).
export const HAIR_COLORS = HERO_HAIR_COLORS.map(hexToNumber);
export const SKIN_TONES = HERO_SKIN_TONES.map(hexToNumber);

/** Bitmaps for the base character (body/legs/head/hair/props/icons), keyed by texture name. */
export const CHARACTER_BITMAPS: Record<string, Bitmap> = {
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
  // M17 (docs/design/depth-25d.md section 6.1): the back (`n`) and side (`e`, west = flipped) views. The unsuffixed keys above are the
  // front (`s`) view. Same palettes, so every tint slot (role colour, skin, hair) works in every view.
  'ch-body-n': {
    rows: [' wwwwww ', 'wwwswwww', 'swwswwws', 'swwswwws', 'swwswwws', ' ssssss '],
    palette: { w: W, s: SHADE },
  },
  'ch-body-e': {
    rows: [' swwww', 'swwwww', 'swwwww', 'swwwww', 'swwwww', ' sssss'],
    palette: { w: W, s: SHADE },
  },
  'ch-legs-n-0': { rows: [' pp  pp ', ' pp  pp ', ' kk  kk '], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-legs-n-1': { rows: [' pp  pp ', ' pp  kk ', ' kk     '], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-legs-n-2': { rows: [' pp  pp ', ' kk  pp ', '     kk '], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-legs-n-sit': { rows: ['        ', ' pppppp ', ' pp  pp '], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-legs-e-0': { rows: ['  pp  ', '  pp  ', '  kkk '], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-legs-e-1': { rows: ['  pp  ', '  p pp', '  k kk'], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-legs-e-2': { rows: ['  pp  ', ' pp p ', ' kk k '], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-legs-e-sit': { rows: ['      ', ' ppppp', ' k  kk'], palette: { p: 0x2d3142, k: 0x15151c } },
  'ch-head-n': { rows: [' ffff ', 'ffffff', 'ffffff', 'ffffff', ' fssf '], palette: { f: W, s: SHADE } },
  'ch-head-e': { rows: [' ffff ', 'ffffff', 'ffffek', 'ffffff', ' ffssf'], palette: { f: W, e: 0x2b2330, k: W, s: SHADE } },
  // Hair from behind: fuller than the front view, it covers the back of the head (rows 2-3).
  'ch-hair-0-n': { rows: [' hhhh ', 'hhhhhh', 'hhhhhh', 'hhhhhh'], palette: { h: W } },
  'ch-hair-1-n': { rows: [' hhhh ', 'hhhhhh', 'hhhhhh', 'hhhhhh', 'hhhhhh', 'hhhhhh'], palette: { h: W } },
  'ch-hair-2-n': { rows: ['h hh h', 'hhhhhh', 'hhhhhh', 'hhhhhh'], palette: { h: W } },
  'ch-hair-3-n': { rows: ['  hh  ', ' hhhh ', 'hhhhhh', 'hhhhhh', 'hhhhhh'], palette: { h: W } },
  'ch-hair-4-n': { rows: [' hhhhh', 'hhhhhh', 'hhhhhh', 'hhhhhh'], palette: { h: W } },
  'ch-hair-5-n': { rows: ['      ', ' hhhh ', ' hhhh '], palette: { h: W } },
  'ch-hair-6-n': { rows: [' hhhh ', 'hhhhhh', 'hhhhhh', 'hhhhhh', 'hhhhhh'], palette: { h: W } },
  // Hair in profile (facing east): the fringe on the front (right) column, the length trailing behind.
  'ch-hair-0-e': { rows: [' hhhh ', 'hhhhhh', 'hhh  h'], palette: { h: W } },
  'ch-hair-1-e': { rows: [' hhhh ', 'hhhhhh', 'hhh  h', 'hhh   ', 'hhh   ', 'hhh   '], palette: { h: W } },
  'ch-hair-2-e': { rows: ['h hh h', 'hhhhhh', 'hh    '], palette: { h: W } },
  'ch-hair-3-e': { rows: ['  hh  ', ' hhhh ', 'hhhhhh', 'hhh   '], palette: { h: W } },
  'ch-hair-4-e': { rows: [' hhhhh', 'hhhhhh', 'hhh  h'], palette: { h: W } },
  'ch-hair-5-e': { rows: ['      ', ' hhh  '], palette: { h: W } },
  'ch-hair-6-e': { rows: [' hhhh ', 'hhhhhh', 'hhh  h', 'hhh   ', 'hhh  h'], palette: { h: W } },
  'ch-shadow': { rows: [' ssssssss ', 'ssssssssss', ' ssssssss '], palette: { s: 0x000000 } },
  // M16: the cast-shadow blob (10 x 10, rounded; stretched along the light direction by Character#setCastShadow).
  'ch-shadow-cast': {
    rows: ['  ssssss  ', ' ssssssss ', 'ssssssssss', 'ssssssssss', 'ssssssssss', 'ssssssssss', 'ssssssssss', 'ssssssssss', ' ssssssss ', '  ssssss  '],
    palette: { s: 0x000000 },
  },
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
  'prop-controller': { rows: ['kkkkkk', 'kdkbrk', 'kkkkkk', 'kk  kk'], palette: { k: 0x55596b, d: 0xdddddd, b: 0x4fa8ff, r: 0xff4a4a } },
  'prop-phone': { rows: ['kkk', 'kbk', 'kbk', 'kbk', 'kkk'], palette: { k: 0x3b3f4e, b: 0x8fd3ff } },
  'prop-can': { rows: ['  g  ', 'bbbbb', 'bwbbb', 'bbbbb', 'bbbbb'], palette: { g: 0xd9d9d9, b: 0x4a90e2, w: 0xcfe9ff } },
  'prop-marker': { rows: ['rr ', 'rrk', ' kk', ' kk', ' k '], palette: { r: 0xe0556a, k: 0x3b3f4e } },
  'prop-mop': { rows: ['  w', '  w', '  w', '  w', ' yy', 'yyy'], palette: { w: 0x8a5a2b, y: 0xe8d9a0 } },
  'prop-parcel': { rows: ['bbbbbb', 'bwbbwb', 'bbbbbb', 'bwbbwb', 'bbbbbb'], palette: { b: 0xc8934f, w: 0xf2e3b8 } },

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
  // M12 G1 drama: strain icons and antic emotes (<= 7x7 before the outline).
  'icon-dizzy-1': { rows: ['y   y', ' y y ', '  y  ', ' y y ', 'y   y'], palette: { y: 0xffe45a }, outline: 0x2a2410 },
  'icon-dizzy-2': { rows: ['  y  ', 'y y y', ' yyy ', 'y y y', '  y  '], palette: { y: 0xffe45a }, outline: 0x2a2410 },
  'icon-dizzy-3': { rows: [' y  y', '  yy ', 'yyyyy', '  yy ', ' y  y'], palette: { y: 0xffe45a }, outline: 0x2a2410 },
  'icon-sweat': { rows: ['  b  ', '  b  ', ' bbb ', 'bbwbb', 'bbbbb', ' bbb '], palette: { b: 0x4fa8ff, w: 0xcfe9ff }, outline: 0x0a1a2e },
  'icon-yawn': { rows: ['  oooo', ' o  o ', ' o  o ', ' o  o ', '  oo  '], palette: { o: 0xf2ecff }, outline: 0x1c1826 },
  'icon-fire': { rows: ['   o  ', '  oo  ', ' ooyo ', 'ooyyoo', 'ooyyoo', ' oooo '], palette: { o: 0xff7a1f, y: 0xffd84a }, outline: 0x2a0e04 },
  'icon-mug': { rows: ['wwwww ', 'wwwwww', 'wwwww ', ' www  '], palette: { w: 0xf5f5f5 }, outline: 0x241c10 },
  'icon-note': { rows: ['  nnnn', '  n  n', '  n   ', 'nnn   ', 'nnn   '], palette: { n: 0xc9a6ff }, outline: 0x1c1030 },
  'icon-dice': { rows: ['wwwww', 'wkwkw', 'wwkww', 'wkwkw', 'wwwww'], palette: { w: 0xf5f5f5, k: 0x333333 }, outline: 0x1c1826 },
  'icon-ball': { rows: ['    ww', 'pp  ww', 'ppp   ', ' pp   ', ' b    '], palette: { w: 0xffffff, p: 0xd9534f, b: 0x8a5a2b }, outline: 0x1c1826 },
  'icon-phone': { rows: [' kkk ', 'kbbbk', 'kbbbk', 'kbbbk', ' kkk '], palette: { k: 0x55596b, b: 0x8fd3ff }, outline: 0x10121a },
  'icon-laugh': { rows: ['h h   ', 'h h   ', 'hhh a ', 'h h a ', 'h h aa'], palette: { h: 0xffd84a, a: 0xffa94a }, outline: 0x2a2410 },
  'icon-megaphone': { rows: ['    o  ', ' kkoo o', 'kkkoooo', ' kkoo o', ' k  o  '], palette: { k: 0xd9d9d9, o: 0xffa94a }, outline: 0x241c10 },
  'icon-alarm': { rows: ['r     r', ' wwwww ', 'wwwkwww', 'wwwkkww', 'wwwwwww', ' wwwww ', ' r   r '], palette: { w: 0xf5f5f5, k: 0x333333, r: 0xff4a4a }, outline: 0x2a0808 },
  'icon-heart': { rows: [' rr rr ', 'rrrrrrr', 'rrrrrrr', ' rrrrr ', '  rrr  ', '   r   '], palette: { r: 0xff5a7a }, outline: 0x2a0812 },
  'icon-gamepad': { rows: ['kkkkkkk', 'kwkkkrk', 'wwwkrkr', 'kwkkkrk', 'kkkkkkk'], palette: { k: 0x6b7088, w: 0xf5f5f5, r: 0xff4a4a }, outline: 0x10121a },
  'icon-paddle': { rows: [' rrrr  ', 'rrrrrr ', 'rrrrrr ', ' rrrr  ', '  bb  w', '  bb   '], palette: { r: 0xd9534f, b: 0x8a5a2b, w: 0xffffff }, outline: 0x1c1826 },
  'icon-chess': { rows: ['  ww  ', ' wwww ', '  ww  ', '  ww  ', ' wwww ', 'wwwwww'], palette: { w: 0xf5f5f5 }, outline: 0x1c1826 },
  'icon-can': { rows: ['  g  ', 'bbbbb', 'bwbbb', 'bbbbb', 'bbbbb', ' bbb '], palette: { g: 0xd9d9d9, b: 0x4a90e2, w: 0xcfe9ff }, outline: 0x0a1a2e },
  'icon-pencil': { rows: ['    pp', '   ypp', '  yyp ', ' yyy  ', 'kyy   ', 'kk    '], palette: { p: 0xff8aa0, y: 0xffd84a, k: 0x555555 }, outline: 0x2a2410 },
  'icon-broom': { rows: ['     w', '    w ', '   w  ', '  yyy ', ' yyyyy', 'yyyyyy'], palette: { w: 0x8a5a2b, y: 0xe8c860 }, outline: 0x2a2410 },
  // M14 A1 KO badges (<= 7x7 before the outline): `icon-ko` + `icon-ko-2` are the two bob frames (KO_FRAMES).
  'icon-ko': { rows: ['  y   w', ' yyy   ', '  y  y ', '    yyy', 'w    y ', '  y    ', ' yyy   '], palette: { y: 0xffe45a, w: 0xffffff }, outline: 0x2a2410 },
  'icon-ko-2': { rows: ['w   y  ', '   yyy ', ' y  y  ', 'yyy    ', ' y   w ', '    y  ', '   yyy '], palette: { y: 0xffe45a, w: 0xffffff }, outline: 0x2a2410 },
  'icon-bandage': { rows: ['     bb', '    bbb', '   bdb ', '  bddb ', ' bbdb  ', 'bbbb   ', 'bb     '], palette: { b: 0xf2c9a0, d: 0xc98a5a }, outline: 0x2a1808 },
  'icon-parcel': { rows: ['bbbbbb', 'bbwwbb', 'bbwwbb', 'wwwwww', 'bbwwbb', 'bbwwbb'], palette: { b: 0xc8934f, w: 0xf2e3b8 }, outline: 0x2a1808 },
};

/** Texture keys of the two KO dizzy frames (bob); the bandage is the single `icon-bandage`. */
export const KO_FRAMES = ['icon-ko', 'icon-ko-2'] as const;

export function withOutline(b: Bitmap): string[] {
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

/** Per-texture alpha for the soft shadow blobs; every other bitmap paints opaque. */
export const BITMAP_ALPHA: Readonly<Record<string, number>> = { 'ch-shadow': 0.28, 'ch-shadow-cast': 0.22 };

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
      g.fillStyle(c, BITMAP_ALPHA[key] ?? 1);
      g.fillRect(x, y, 1, 1);
    }
  });
  g.generateTexture(key, w, rows.length);
  g.destroy();
}

export function generateTextures(scene: Phaser.Scene) {
  for (const [key, b] of Object.entries(CHARACTER_BITMAPS)) paintBitmap(scene, key, b);
}

export const HAIR_STYLES = HERO_HAIR_STYLE_COUNT;

/** M17: a character body-part texture key in its front (`s`) view: `ch-body`, `ch-head`, `ch-legs-<frame>` or `ch-hair-<style>`. */
export type ViewBase = string;

/**
 * M17: the texture of a body part in a view. `s` is the legacy key (`ch-body`, `ch-legs-1`, `ch-hair-3`); `n` / `e` add the view:
 * `ch-body-n`, `ch-legs-e-1`, `ch-hair-3-e` (docs/design/depth-25d.md section 6.1). `w` is `e` flipped, so it never reaches here.
 */
export function viewTexture(base: ViewBase, view: View): string {
  if (view === 's') return base;
  return base.startsWith('ch-legs-') ? `ch-legs-${view}-${base.slice('ch-legs-'.length)}` : `${base}-${view}`;
}
