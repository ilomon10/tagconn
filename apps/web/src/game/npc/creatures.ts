import type * as Phaser from 'phaser';
import type { Bitmap } from '../textures';
import { paintBitmap } from '../textures';
import type { CreatureId } from '../themes/types';
import { creatureTextureKey } from './types';

/**
 * NPC creature art (M13, ADR #22: code-drawn, no asset files). Each creature has two frames (idle
 * and a step / tail-flick / blink) at most 14x10 px, side-on, facing right, feet on the bottom row.
 * Colours are baked in (creatures are never tinted). The raw bitmaps are exported for tests and previews.
 */

export const CREATURE_MAX_W = 14;
export const CREATURE_MAX_H = 10;

const pal = (p: Bitmap['palette']): Bitmap['palette'] => p;

const DOG = pal({ b: 0xc8934f, d: 0x8a5a2b, k: 0x1c1418, w: 0xf6ecd6, r: 0xe0556a });
const CAT = pal({ c: 0xe8944a, s: 0xb8662a, e: 0x1c1418, w: 0xf6ecd6, p: 0xf2a0b0 });
const MON = pal({ m: 0x7a4acb, d: 0x52308f, w: 0xffffff, y: 0xffe45a, k: 0x1c1418, h: 0xf0e0b0 });
const WOLF = pal({ g: 0x8d96a6, d: 0x5b6373, w: 0xe6ecf5, k: 0x1c1418, y: 0xffd84a });
const FAM = pal({ p: 0xa070f0, d: 0x6a40b8, y: 0xffe45a, k: 0x1c1418, w: 0xf2ecff });
const SLIME = pal({ g: 0x5ed67a, d: 0x2f9a52, h: 0xcaffd6, k: 0x16301c });
const HOUND = pal({ s: 0xb4c0d4, d: 0x6a768c, c: 0x4fe3ff, k: 0x1c1822, r: 0xff5a5a });
const ASTRO = pal({ c: 0xf2f2f8, s: 0xb0b8c8, g: 0x8fd3ff, e: 0x1c1418, o: 0xe8944a, d: 0x4a5266 });
const VOID = pal({ v: 0x3a1f6a, d: 0x1c0f38, e: 0xd8a0ff, p: 0x8a5aff });

export const CREATURE_BITMAPS: Record<CreatureId, readonly [Bitmap, Bitmap]> = {
  dog: [
    { palette: DOG, rows: [
      '        dd d ',
      '  b    bbbbb ',
      ' bb  bbbbkbbk',
      'bbbbbbbbbbbr ',
      ' bbbbbbbbbb  ',
      ' bwbbbbbbwb  ',
      ' bb bb  bb bb',
      ' dd dd  dd dd',
    ] },
    { palette: DOG, rows: [
      '        dd d ',
      '       bbbbb ',
      'b    bbbbkbbk',
      'bb bbbbbbbbbr',
      ' bbbbbbbbbb  ',
      ' bwbbbbbbwb  ',
      '  bb bb bb bb',
      '  dd dd dd dd',
    ] },
  ],
  cat: [
    { palette: CAT, rows: [
      '        c  c',
      '        cccc',
      '        cece',
      '  c     ccpc',
      ' cc   ccccc  ',
      ' cscccccscc  ',
      ' cccccccccc  ',
      '  cc  cc  cc ',
    ].map((r) => r.padEnd(12)) },
    { palette: CAT, rows: [
      '        c  c',
      '        cccc',
      '        cccc',
      'c       ccpc',
      'cc    ccccc  ',
      ' cscccccscc  ',
      ' cccccccccc  ',
      '  cc cc  cc  ',
    ].map((r) => r.padEnd(12)) },
  ],
  monster: [
    { palette: MON, rows: [
      '  h      h  ',
      '  hm    mh  ',
      ' mmmmmmmmmm ',
      'mmwwmmmmwwmm',
      'mmwkmmmmwkmm',
      'mmmmmmmmmmmm',
      'mmwywywywymm',
      'dmmmmmmmmmmd',
      ' dmmmmmmmmd ',
      ' dd      dd ',
    ] },
    { palette: MON, rows: [
      '  h      h  ',
      '  hm    mh  ',
      ' mmmmmmmmmm ',
      'mmwwmmmmwwmm',
      'mmkkmmmmkkmm',
      'mmmmmmmmmmmm',
      'mmywywywywmm',
      'dmmmmmmmmmmd',
      ' dmmmmmmmmd ',
      '  dd    dd  ',
    ] },
  ],
  wolf: [
    { palette: WOLF, rows: [
      '         d d ',
      '        ggggg',
      '  d   ggggykg',
      ' dgg ggggggwg',
      'dggggggggggg ',
      ' ggwggggggwg ',
      ' gg gg  gg gg',
      ' dd dd  dd dd',
    ].map((r) => r.padEnd(13)) },
    { palette: WOLF, rows: [
      '         d d ',
      '        ggggg',
      'd     ggggykg',
      'dgg  ggggggwg',
      ' ggggggggggg ',
      ' ggwggggggwg ',
      '  gg gg gg gg',
      '  dd dd dd dd',
    ].map((r) => r.padEnd(13)) },
  ],
  familiar: [
    { palette: FAM, rows: [
      ' d    d ',
      ' pp  pp ',
      ' pppppp ',
      'ppykkypp',
      'ppppppp ',
      'dpwwwwpd',
      ' pwwwwp ',
      '  y  y  ',
    ] },
    { palette: FAM, rows: [
      '        ',
      ' d    d ',
      ' pp  pp ',
      'ppykkypp',
      'dppppppd',
      ' pwwwwp ',
      ' pwwwwp ',
      '  y  y  ',
    ] },
  ],
  slime: [
    { palette: SLIME, rows: [
      '   gggg   ',
      '  ghggggg ',
      ' gggggggg ',
      ' ggkggkgg ',
      'gggggggggg',
      'dgggggggd ',
      ' dddddddd ',
    ] },
    { palette: SLIME, rows: [
      '          ',
      '   gggg   ',
      '  gghggg  ',
      ' ggkggkgg ',
      'gggggggggg',
      'ggggggggggd',
      'dddddddddd',
    ] },
  ],
  'hover-hound': [
    { palette: HOUND, rows: [
      '         d d ',
      '        sssss',
      '  d   ssssckr',
      ' dss ssssssss',
      'dssssssssss  ',
      ' ssddssssdss ',
      ' ss ss  ss ss',
      '  cccccccccc ',
    ].map((r) => r.padEnd(13)) },
    { palette: HOUND, rows: [
      '         d d ',
      '        sssss',
      'd     ssssckr',
      'dss  ssssssss',
      ' ssssssssss  ',
      ' ssddssssdss ',
      '  ss ss ss ss',
      ' c c c c c c ',
    ].map((r) => r.padEnd(13)) },
  ],
  'astro-cat': [
    { palette: ASTRO, rows: [
      '  gggggg  ',
      ' gg    gg ',
      'g  o  o  g',
      'g  eoeo  g',
      'g   oo   g',
      ' gg    gg ',
      ' ssccccss ',
      ' scccccs  ',
      ' cccccccc ',
      '  dd  dd  ',
    ] },
    { palette: ASTRO, rows: [
      '  gggggg  ',
      ' gg    gg ',
      'g  o  o  g',
      'g  oooo  g',
      'g   oo   g',
      ' gg    gg ',
      ' ssccccss ',
      ' scccccs  ',
      ' cccccccc ',
      ' dd    dd ',
    ] },
  ],
  'void-blob': [
    { palette: VOID, rows: [
      '  p    p  ',
      '  vvvvvv  ',
      ' vvvvvvvv ',
      'vveevveevv',
      'vveevveevv',
      'vvvvvvvvvv',
      'dvvvvvvvvd',
      ' dvdvvdvd ',
    ] },
    { palette: VOID, rows: [
      '          ',
      ' p  vv  p ',
      ' vvvvvvvv ',
      'vveevveevv',
      'vvvvvvvvvv',
      'vvvvvvvvvv',
      'dvvvvvvvvd',
      'dvdvdvdvdv',
    ] },
  ],
};

/** Draws every creature frame once (idempotent through `paintBitmap`). */
export function paintCreatureTextures(scene: Phaser.Scene): void {
  for (const [id, frames] of Object.entries(CREATURE_BITMAPS) as [CreatureId, readonly [Bitmap, Bitmap]][]) {
    paintBitmap(scene, creatureTextureKey(id, 0), frames[0]);
    paintBitmap(scene, creatureTextureKey(id, 1), frames[1]);
  }
}
