// apps/web/src/game/postfx/lights.ts  (M8 8o.1c: light-source extraction for the bloom light layer;
// M8 8p T4: fireplaces + northWall windows + tiny appliance indicator glows)
//
// Pure: reads a `GeneratedMap` (procgen output, style-agnostic) and returns the points the light
// layer should draw a soft additive glow at. Kept separate from `themes/*.ts` (T1's files) — those
// already paint their own static torch/lantern art and a plain (unblurred) glow pool; this is an
// additional, independently-owned layer purely for the bloom pass, so it never touches theme code.
import type { OfficeStyle } from '@tagconn/shared';
import { MULTIVERSE_THEME_ID } from '@tagconn/shared';
import type { GeneratedMap } from '../procgen/types';
import type { LightSource } from './types';

/** Per-style tint for a wall-mounted light (torch/lantern/sconce), a warm point light (desk lamp)
 *  vs. a cool one (monitor/console/server-rack glow), and a north-wall window's own glow (daylight
 *  for modern, an arched glowing window for guild, a rift-cyan aperture for the Multiverse) — same
 *  family of hues the themes already use for their own accents (guild's torch flame `0xff8a3a`, its
 *  server pedestal `0x9fd8ff`, ...). */
interface StylePalette {
  wallLight: number;
  warmLight: number;
  coolLight: number;
  windowLight: number;
}

const PALETTES: Record<OfficeStyle | typeof MULTIVERSE_THEME_ID, StylePalette> = {
  modern: { wallLight: 0xffe4b5, warmLight: 0xffd27a, coolLight: 0x8fd8ff, windowLight: 0xd9f0ff },
  guild: { wallLight: 0xff8a3a, warmLight: 0xffcf8a, coolLight: 0x9fd8ff, windowLight: 0xffb35c },
  [MULTIVERSE_THEME_ID]: { wallLight: 0xb07aff, warmLight: 0xd8b8ff, coolLight: 0x7ef0e8, windowLight: 0x5be8ff },
};

/** Furniture kinds that read as a light-emitting prop (lamps) or a glowing screen/rack (consoles,
 *  lab/server equipment) — everything else in `FurnitureKind` is unlit except `fireplace` (its own,
 *  larger, warm flame light — see `FIRE_*` below) and the tiny appliance indicator LEDs below. */
const WARM_FURNITURE = new Set(['lamp']);
const COOL_FURNITURE = new Set(['console', 'equipment']);

/** M8 8p: appliances that only get a tiny indicator-LED glow — the lowest-priority light sources,
 *  pushed after every decor and main furniture light so `maxLights` truncation drops them first. */
const TINY_FURNITURE = new Set(['coffee-machine', 'fridge']);

const WALL_LIGHT_RADIUS = 10;
const WARM_LIGHT_RADIUS = 7;
const COOL_LIGHT_RADIUS = 8;

/** M8 8p: fireplace flame — warm orange and noticeably larger than a torch/sconce, since it's a
 *  whole appliance rather than a wall fixture. Same warm-orange hue in every style (a flame reads as
 *  fire regardless of the room's architecture); only the guild fireplace flickers (`animate()`'s
 *  `torchFlicker` convention — an open flame — vs. modern's electric flame-screen media wall and
 *  rift's crystal/void variant, which hold steady). */
const FIRE_COLOR = 0xff6a2a;
const FIRE_RADIUS = 14;

/** M8 8p: a `northWall` `'window'` slot's glow — placed at the wall face (the slot's own `y`, the
 *  WALL row), not the floor tile in front of it. Radius scales with `span` (a 2-tile window is a
 *  bigger aperture than a 1-tile one). */
const WINDOW_RADIUS_BASE = 9;
const WINDOW_RADIUS_PER_SPAN = 5;

/** M8 8p: tiny coffee-machine/fridge indicator LEDs — barely-there accents, not real room lighting. */
const TINY_LIGHT_RADIUS = 3;

/**
 * Extracts light sources from a `GeneratedMap`, in a fixed, deterministic priority order so that
 * truncating to `maxLights` always drops the same — least prominent — sources first regardless of
 * quality tier:
 *
 * 1. every `decor` slot of kind `'wall-light'` (torches, lanterns, sconces — always a light, and the
 *    one that flickers when it reads as an open flame);
 * 2. every `northWall` slot of kind `'window'` (daylight/arched-glow/rift-cyan, per style);
 * 3. `lamp`/`console`/`equipment`/`fireplace` furniture as point lights (map order);
 * 4. tiny `coffee-machine`/`fridge` indicator-LED glows (map order) — lowest priority, dropped first.
 */
export function extractLightSources(map: GeneratedMap, style: OfficeStyle | typeof MULTIVERSE_THEME_ID, maxLights: number): LightSource[] {
  const palette = PALETTES[style];
  const T = map.tileSize;
  const sources: LightSource[] = [];
  const tiny: LightSource[] = [];

  for (const slot of map.decor) {
    if (slot.kind !== 'wall-light') continue;
    const x = slot.x * T + T / 2;
    const y = slot.y * T + T / 2;
    // Only the guild torch reads as an open flame (see `guild.ts`'s own `torchFlicker` on its
    // static art) — the modern sconce is electric and the rift lantern is a steady magical glow.
    sources.push({ x, y, depth: slot.y * T, color: palette.wallLight, radius: WALL_LIGHT_RADIUS, flicker: style === 'guild' });
  }

  for (const slot of map.northWall) {
    if (slot.kind !== 'window') continue;
    // Centered over the slot's full span, at the wall row itself (the face), not the floor tile the
    // window looks out from.
    const x = (slot.x + slot.span / 2) * T;
    const y = slot.y * T + T / 2;
    const radius = WINDOW_RADIUS_BASE + (slot.span - 1) * WINDOW_RADIUS_PER_SPAN;
    sources.push({ x, y, depth: slot.y * T, color: palette.windowLight, radius, flicker: false });
  }

  for (const f of map.furniture) {
    const isWarm = WARM_FURNITURE.has(f.kind);
    const isCool = !isWarm && COOL_FURNITURE.has(f.kind);
    const isFire = !isWarm && !isCool && f.kind === 'fireplace';
    const isTiny = !isWarm && !isCool && !isFire && TINY_FURNITURE.has(f.kind);
    if (!isWarm && !isCool && !isFire && !isTiny) continue;
    const x = (f.x + f.w / 2) * T;
    const y = (f.y + f.h / 2) * T;
    const depth = (f.y + f.h) * T;
    if (isTiny) {
      tiny.push({ x, y, depth, color: f.kind === 'coffee-machine' ? palette.warmLight : palette.coolLight, radius: TINY_LIGHT_RADIUS, flicker: false });
      continue;
    }
    sources.push({
      x,
      y,
      depth,
      color: isFire ? FIRE_COLOR : isWarm ? palette.warmLight : palette.coolLight,
      radius: isFire ? FIRE_RADIUS : isWarm ? WARM_LIGHT_RADIUS : COOL_LIGHT_RADIUS,
      flicker: isFire && style === 'guild',
    });
  }

  const all = sources.concat(tiny);
  return maxLights >= 0 ? all.slice(0, maxLights) : all;
}
