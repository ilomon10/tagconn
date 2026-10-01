import type * as Phaser from 'phaser';
import type { Bitmap } from '../textures';
import { paintBitmap } from '../textures';

/**
 * Battle effect art (M14 A1, ADR #22: code-drawn). Small bitmaps the scene scales up and tweens;
 * the white ones (`fx-slash`, `fx-hit`, `fx-sparkle`, `fx-wedge`) are meant to be tinted per type.
 * The raw bitmaps are exported for tests and previews.
 */

export const FX_MAX = 16;

const W = 0xffffff;
const pal = (p: Bitmap['palette']): Bitmap['palette'] => p;

export const FX_BITMAPS = {
  /** Diagonal sword stroke, thick in the middle. */
  'fx-slash': { palette: pal({ w: W, s: 0xc9c9c9 }), rows: [
    '          ww',
    '         www',
    '        wwws',
    '       wwws ',
    '      wwws  ',
    '     wwws   ',
    '    wwws    ',
    '   wwws     ',
    '  wwws      ',
    ' wwws       ',
    'wwws        ',
    'ws          ',
  ] },
  /** Plain impact burst. */
  'fx-hit': { palette: pal({ w: W, y: 0xffe45a }), rows: [
    '    w    ',
    ' w  w  w ',
    '  w yy w ',
    '   wyyw  ',
    'wwwyywwww',
    '   wyyw  ',
    '  w yy w ',
    ' w  w  w ',
    '    w    ',
  ] },
  /** Bigger, spikier burst for critical hits. */
  'fx-crit': { palette: pal({ y: 0xffe45a, o: 0xff9a2a, w: W, r: 0xff4a4a }), rows: [
    '      y      ',
    '  o   y   o  ',
    '   o  y  o   ',
    '    o oyo    ',
    ' o   oyyo  o ',
    '  oo yywyy   ',
    'yyyyyywwwyyyy',
    '   oo yywyy  ',
    ' o   oyyo  o ',
    '    o oyo    ',
    '   o  y  o   ',
    '  o   y   o  ',
    '      y      ',
  ] },
  'fx-sparkle': { palette: pal({ w: W }), rows: ['   w   ', '   w   ', ' w w w ', 'wwwwwww', ' w w w ', '   w   ', '   w   '] },
  'fx-heal': { palette: pal({ g: 0x6cf08a, l: 0xcaffd6 }), outline: 0x0a2410, rows: [
    '  gg  ',
    '  gl  ',
    'gggggg',
    'glgggg',
    '  gg  ',
    '  gg  ',
  ] },
  /** Translucent-looking bubble ring with a glint. */
  'fx-shield': { palette: pal({ c: 0x4fe3ff, b: 0x2f8ad8, w: W }), rows: [
    '    cccccc    ',
    '  ccb    bcc  ',
    ' cb  ww    bc ',
    ' c  w       c ',
    'cb           bc',
    'c             c',
    'c             c',
    'c             c',
    'c             c',
    'cb           bc',
    ' c           c ',
    ' cb         bc ',
    '  ccb     bcc ',
    '    cccccc    ',
  ].map((r) => r.padEnd(14)) },
  /** Stun: two spinning stars. */
  'fx-stun': { palette: pal({ y: 0xffe45a, o: 0xffa94a }), outline: 0x2a2410, rows: [
    '  y     o   ',
    ' yyy   ooo  ',
    '  y     o   ',
  ] },
  /** Merge conflict marker "<<>>". */
  'fx-merge': { palette: pal({ r: 0xff5a7a, p: 0xc9a6ff }), outline: 0x1c1030, rows: [
    '  r  r p  p  ',
    ' r  r   p  p ',
    'r  r     p  p',
    ' r  r   p  p ',
    '  r  r p  p  ',
  ] },
  /** Burnout flame. */
  'fx-burnout': { palette: pal({ o: 0xff7a1f, y: 0xffd84a, r: 0xd8341f }), outline: 0x2a0e04, rows: [
    '   o   ',
    '  oo   ',
    '  ooo  ',
    ' ooyoo ',
    'rooyyoo',
    'rooyyor',
    ' rooor ',
    '  rrr  ',
  ] },
  /** Buff: a chunky up arrow. */
  'fx-buff': { palette: pal({ o: 0xffa94a, y: 0xffe45a }), outline: 0x2a1808, rows: [
    '   y   ',
    '  yoy  ',
    ' yoooy ',
    'yoooooy',
    '  ooo  ',
    '  ooo  ',
    '  ooo  ',
  ].map((r) => r.padEnd(7)) },
  /** Swirl wedge: a right triangle the entry transition rotates around the stage. */
  'fx-wedge': { palette: pal({ w: W }), rows: Array.from({ length: FX_MAX }, (_, i) => 'w'.repeat(i + 1).padEnd(FX_MAX)) },
} satisfies Record<string, Bitmap>;

export type FxKey = keyof typeof FX_BITMAPS;
export const FX_KEYS = Object.keys(FX_BITMAPS) as FxKey[];

/** Paints every effect texture once; texture key = bitmap key (idempotent through `paintBitmap`). */
export function paintFxTextures(scene: Phaser.Scene): void {
  for (const key of FX_KEYS) paintBitmap(scene, key, FX_BITMAPS[key]);
}
