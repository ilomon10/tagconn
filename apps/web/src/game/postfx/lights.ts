// apps/web/src/game/postfx/lights.ts  (M8 8o.1c: light-source extraction for the bloom light layer)
//
// Pure: reads a `GeneratedMap` (procgen output, style-agnostic) and returns the points the light
// layer should draw a soft additive glow at. Kept separate from `themes/*.ts` (T1's files) — those
// already paint their own static torch/lantern art and a plain (unblurred) glow pool; this is an
// additional, independently-owned layer purely for the bloom pass, so it never touches theme code.
import type { OfficeStyle } from '@tagconn/shared';
import { MULTIVERSE_THEME_ID } from '@tagconn/shared';
import type { GeneratedMap } from '../procgen/types';
import type { LightSource } from './types';

/** Per-style tint for a wall-mounted light (torch/lantern/sconce) and a warm point light (desk
 *  lamp) vs. a cool one (monitor/console/server-rack glow) — same family of hues the themes already
 *  use for their own accents (guild's torch flame `0xff8a3a`, its server pedestal `0x9fd8ff`, ...). */
interface StylePalette {
  wallLight: number;
  warmLight: number;
  coolLight: number;
}

const PALETTES: Record<OfficeStyle | typeof MULTIVERSE_THEME_ID, StylePalette> = {
  modern: { wallLight: 0xffe4b5, warmLight: 0xffd27a, coolLight: 0x8fd8ff },
  guild: { wallLight: 0xff8a3a, warmLight: 0xffcf8a, coolLight: 0x9fd8ff },
  [MULTIVERSE_THEME_ID]: { wallLight: 0xb07aff, warmLight: 0xd8b8ff, coolLight: 0x7ef0e8 },
};

/** Furniture kinds that read as a light-emitting prop (lamps) or a glowing screen/rack (consoles,
 *  lab/server equipment) — everything else in `FurnitureKind` is unlit. There is no `window` kind
 *  in `procgen/types.ts` yet, so windows aren't a light source today. */
const WARM_FURNITURE = new Set(['lamp']);
const COOL_FURNITURE = new Set(['console', 'equipment']);

const WALL_LIGHT_RADIUS = 10;
const WARM_LIGHT_RADIUS = 7;
const COOL_LIGHT_RADIUS = 8;

/**
 * Extracts light sources from a `GeneratedMap`: every `decor` slot of kind `'wall-light'` (torches,
 * lanterns, sconces — always a light, and the one that flickers when it reads as an open flame), plus
 * `lamp`/`console`/`equipment` furniture as smaller steady point lights. Order is deterministic
 * (decor first, then furniture, both in map order) so truncating to `maxLights` always drops the
 * same — least prominent — sources first regardless of quality tier.
 */
export function extractLightSources(map: GeneratedMap, style: OfficeStyle | typeof MULTIVERSE_THEME_ID, maxLights: number): LightSource[] {
  const palette = PALETTES[style];
  const T = map.tileSize;
  const sources: LightSource[] = [];

  for (const slot of map.decor) {
    if (slot.kind !== 'wall-light') continue;
    const x = slot.x * T + T / 2;
    const y = slot.y * T + T / 2;
    // Only the guild torch reads as an open flame (see `guild.ts`'s own `torchFlicker` on its
    // static art) — the modern sconce is electric and the rift lantern is a steady magical glow.
    sources.push({ x, y, depth: slot.y * T, color: palette.wallLight, radius: WALL_LIGHT_RADIUS, flicker: style === 'guild' });
  }

  for (const f of map.furniture) {
    const isWarm = WARM_FURNITURE.has(f.kind);
    const isCool = !isWarm && COOL_FURNITURE.has(f.kind);
    if (!isWarm && !isCool) continue;
    const x = (f.x + f.w / 2) * T;
    const y = (f.y + f.h / 2) * T;
    sources.push({
      x,
      y,
      depth: (f.y + f.h) * T,
      color: isWarm ? palette.warmLight : palette.coolLight,
      radius: isWarm ? WARM_LIGHT_RADIUS : COOL_LIGHT_RADIUS,
      flicker: false,
    });
  }

  return maxLights >= 0 ? sources.slice(0, maxLights) : sources;
}
