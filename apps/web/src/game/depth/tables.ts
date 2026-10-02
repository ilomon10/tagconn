// M17 depth tables (docs/design/depth-25d.md section 1.2). Data + tiny pure helpers; D2: by kind and facing only.
import type { Facing } from '@tagconn/shared';
import type { PlacedFurniture } from '../procgen/types';
import { kindHeight } from '../lighting/heights';
import type { SpriteClass } from './types';

/** Kinds a character can be inside: the whole art is baked under them, a south strip is drawn over them. */
export type SitInKind = 'chair' | 'armchair' | 'sofa' | 'booth' | 'bench' | 'reception-desk';
/** Px of the footprint's SOUTH strip that becomes the front sprite, per facing. 0 = no strip for that facing. Tuned by eye in W2 A1. */
export const FRONT_STRIP_PX: Record<SitInKind, Record<Facing, number>> = {
  chair:            { n: 7,  e: 3,  w: 3,  s: 0 },
  armchair:         { n: 8,  e: 4,  w: 4,  s: 0 },
  sofa:             { n: 8,  e: 4,  w: 4,  s: 0 },
  booth:            { n: 10, e: 4,  w: 4,  s: 2 },
  bench:            { n: 4,  e: 2,  w: 2,  s: 0 },
  /** The counter front: today's `RECEPTIONIST_DESK_FRONT_DY = 6` cut, i.e. the bottom 10 px (OfficeScene.ts:82, 602). */
  'reception-desk': { n: 10, e: 10, w: 10, s: 10 },
};
/** Px around a footprint a painter may use (overdraw against a north wall is `MAX_OVERDRAW_PX = 12`; shadows poke 2 px; booth backs 2 px sideways). */
export const SPRITE_MARGIN = { top: 16, side: 2, bottom: 2 } as const;
/** Sprite depth = south edge minus this, so a character whose feet sit exactly on the edge row (`y*T + 14` vs `(y+1)*T`) is behind it. */
export const DEPTH_EPSILON = 0.5;
/** Sprites at or above this height take part in the see-through fade (desks and tables do not; bookcases, racks, appliances do). */
export const SEE_THROUGH_MIN_HEIGHT = 10;
export const ATLAS_WIDTH = 1024;
export const ATLAS_MAX_HEIGHT = 2048;
/** Hard caps on GPU textures per theme atlas (security audit L1, L2): frames past either cap are demoted to baked. */
export const ATLAS_MAX_PAGES = 2;
export const ATLAS_MAX_OWN_TEXTURES = 64;

export const isSitInKind = (k: string): k is SitInKind => Object.hasOwn(FRONT_STRIP_PX, k);
/** `sit-in` for the table above, `sprite` when `kindHeight(kind) > 0`, else `baked`. Own-property guarded (`constructor` → `baked`). */
export function spriteClassOf(kind: string): SpriteClass {
  if (isSitInKind(kind)) return 'sit-in';
  return kindHeight(kind) > 0 ? 'sprite' : 'baked';
}
/** Everything a painter reads, so equal keys paint identical command streams (property-tested, §9 test 2). */
export const frameKey = (f: PlacedFurniture): string =>
  `${f.kind}|${f.variant}|${f.facing ?? 's'}|${f.w}x${f.h}|${f.againstNorthWall ? 1 : 0}|${f.roomType}|${f.trigger ?? ''}`;
