import type * as Phaser from 'phaser';
import type { Bitmap } from '../textures';
import { paintBitmap } from '../textures';
import { paintCreatureTextures } from '../npc/creatures';
import { SHADES_TEXTURE } from '../npc/types';
import type { Costume } from './types';

/**
 * Costume art: hat, cloak and hand-prop bitmaps, in the same tiny-ASCII style as `../textures.ts`
 * (reusing its `paintBitmap`). Hats and the cloak use tintable placeholders (`h` = main, `s` =
 * shade) so `Costume.hatColor` / the role colour recolour them, exactly like `ch-body`/`ch-hair-*`.
 * Hand props use fixed baked colours, like the existing `prop-*` bitmaps.
 *
 * The raw bitmap data is exported (`HAT_BITMAPS`, `STAFF_BITMAPS`, `CLOAK_BITMAP`, `GOGGLES_BITMAP`)
 * so `../heroPreview.ts` can paint the same art on a plain 2D canvas, with no Phaser scene.
 */

export type Hat = NonNullable<Costume['hat']>;
export type Staff = NonNullable<Costume['staff']>;

export const HAT_BITMAPS: Partial<Record<Hat, Bitmap>> = {
  wizard: {
    rows: ['   h   ', '  hhh  ', '  hsh  ', ' hhhhh ', ' hshsh ', 'hhhhhhh'],
    palette: { h: 0xffffff, s: 0xc9c9c9 },
  },
  hood: {
    rows: [' hhhh ', 'hhhhhh', 'hh  hh', 'h    h', 'h    h'],
    palette: { h: 0xffffff },
  },
  crown: {
    rows: ['h h h', 'hhhhh', ' hsh '],
    palette: { h: 0xffffff, s: 0xc9c9c9 },
  },
  helm: {
    rows: [' hhhhh ', 'hhhhhhh', 'hh h hh', 'hhh hhh', ' hhhhh '],
    palette: { h: 0xffffff },
  },
  'bard-cap': {
    rows: ['  hhh  ', ' hhhhhs', 'hhhhh s', 'h    h '],
    palette: { h: 0xffffff, s: 0xc9c9c9 },
  },
  circlet: {
    rows: ['h h h h', ' hshsh '],
    palette: { h: 0xffffff, s: 0xc9c9c9 },
  },
  // NPC hats (M13): cap (courier/janitor), police-cap (badge-front peaked cap), fedora, hardhat.
  cap: {
    rows: [' hhhh  ', 'hhhhhh ', 'hhhhhhss'],
    palette: { h: 0xffffff, s: 0xc9c9c9 },
  },
  'police-cap': {
    rows: [' hhhhh ', 'hhhhhhh', 'hhhsshh', 'sssssss'],
    palette: { h: 0xffffff, s: 0xc9c9c9 },
  },
  fedora: {
    rows: ['  hhh  ', ' hhhhh ', ' hsssh ', 'sssssss'],
    palette: { h: 0xffffff, s: 0xc9c9c9 },
  },
  hardhat: {
    rows: ['  hhh  ', ' hhhhh ', 'hhhhhhh', 'sssssss'],
    palette: { h: 0xffffff, s: 0xc9c9c9 },
  },
};

export const STAFF_BITMAPS: Partial<Record<Staff, Bitmap>> = {
  staff: {
    rows: [' gg ', 'gyyg', ' gg ', ' bb ', ' bb ', ' bb ', ' bb '],
    palette: { g: 0x8a5aff, y: 0xd8c6ff, b: 0x6b4a2c },
  },
  wand: {
    rows: [' cc ', 'ccyc', ' cc ', '  b ', '  b '],
    palette: { c: 0x9fd8ff, y: 0xffffff, b: 0x6b4a2c },
  },
  hammer: {
    rows: ['sssss', 'sssss', '  b  ', '  b  ', '  b  '],
    palette: { s: 0x8a94a6, b: 0x5a3a1e },
  },
  quill: {
    rows: ['   f', '  ff', ' ff ', 'f   ', 'k   '],
    palette: { f: 0xf2ecff, k: 0x2a2a33 },
  },
  lute: {
    rows: [' bb ', 'bwwb', 'bwwb', ' bb ', '  k ', '  k '],
    palette: { b: 0x6b4a2c, w: 0xd8b078, k: 0x2a2a33 },
  },
  shield: {
    rows: [' sss ', 'sswss', 'sswss', ' sss ', '  s  '],
    palette: { s: 0x8a94a6, w: 0xe6ecf5 },
  },
  // NPC props (M13): baked colours like the rest.
  mop: {
    rows: ['  b ', '  b ', '  b ', '  b ', '  b ', 'wwww', 'wwww'],
    palette: { b: 0x8a5a2b, w: 0xdfe6ee },
  },
  parcel: {
    rows: ['bbbbb', 'bwwwb', 'bbwbb', 'bwwwb', 'bbbbb'],
    palette: { b: 0xc8934f, w: 0xf2e3b8 },
  },
  'watering-can': {
    rows: ['  ss  ', ' ssss ', 'sbbbbs', 'sbbbbs', ' ssss '],
    palette: { s: 0x4f9bd0, b: 0x7cc4f0 },
  },
  clipboard: {
    rows: ['  dd ', 'wwwww', 'wlwlw', 'wwwww', 'wlwlw', 'wwwww'],
    palette: { d: 0x8a94a6, w: 0xf2ecff, l: 0x555a6a },
  },
};

export const CLOAK_BITMAP: Bitmap = {
  rows: [' hhhhhh ', 'hhhhhhhh', 'hhhhhhhh', 'hhhhhhhh', 'hhhhhhhh', 'hhhhhhhh', 'h      h'],
  palette: { h: 0xffffff },
};

export const GOGGLES_BITMAP: Bitmap = {
  rows: ['oo oo', 'ogogo'],
  palette: { o: 0x3a3f4e, g: 0x8fd3ff },
};

/** Dark shades for the CIA agent (drawn over the head's eye row). */
export const SHADES_BITMAP: Bitmap = {
  rows: ['kkkkkk', 'kgkkgk'],
  palette: { k: 0x15151c, g: 0x3a4a66 },
};

export const CLOAK_TEXTURE = 'guild-cloak';
export const GOGGLES_TEXTURE = 'guild-goggles';

export const hatTextureKey = (hat: Hat): string => `guild-hat-${hat}`;
export const staffTextureKey = (staff: Staff): string => `guild-prop-${staff}`;

/** Draws every costume texture once (idempotent, like `generateTextures`). */
export function paintCostumeTextures(scene: Phaser.Scene): void {
  for (const [hat, bitmap] of Object.entries(HAT_BITMAPS)) paintBitmap(scene, hatTextureKey(hat as Hat), bitmap!);
  for (const [staff, bitmap] of Object.entries(STAFF_BITMAPS)) paintBitmap(scene, staffTextureKey(staff as Staff), bitmap!);
  paintBitmap(scene, CLOAK_TEXTURE, CLOAK_BITMAP);
  paintBitmap(scene, GOGGLES_TEXTURE, GOGGLES_BITMAP);
  paintBitmap(scene, SHADES_TEXTURE, SHADES_BITMAP);
  paintCreatureTextures(scene);
}
