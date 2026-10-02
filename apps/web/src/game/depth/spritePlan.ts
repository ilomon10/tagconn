// M17 D1: which furniture becomes a y-sorted sprite (docs/design/depth-25d.md sections 2.1 and 3.1). Pure.
import type { GeneratedMap, PlacedFurniture } from '../procgen/types';
import { kindHeight } from '../lighting/heights';
import { FRONT_STRIP_PX, SPRITE_MARGIN, isSitInKind, spriteClassOf } from './tables';
import type { FrameSpec, FurnitureSprite, SpritePlan } from './types';

export interface PlanInput {
  map: Pick<GeneratedMap, 'furniture' | 'tileSize' | 'cols' | 'rows'>;
  /** `office.depth.sprites`; false = every item baked, strips still emitted. */
  sprites: boolean;
  maxSprites: number;
  /** Theme id at a tile (base theme or the Multiverse realm's), for `FrameSpec.themeId`. */
  themeIdAt: (x: number, y: number) => string;
}

/** The atlas frame name of an item: its `frameKey` qualified by the theme that paints it (two realms can share a key). */
export const planFrameKey = (themeId: string, f: PlacedFurniture): string =>
  `${themeId}|${f.kind}|${f.variant}|${f.facing ?? 's'}|${f.w}x${f.h}|${f.againstNorthWall ? 1 : 0}|${f.roomType}|${f.trigger ?? ''}`;

/** Classifies every item (section 2.1), builds strips, dedupes frames by `frameKey` + theme id, and applies the cap: `sprite`-class items are
 *  kept by `kindHeight` desc, then `baseY` asc (deterministic), the rest are demoted to `baked`. Strips never count against the cap. */
export function planSprites(input: PlanInput): SpritePlan {
  const { map, maxSprites, themeIdAt } = input;
  const T = map.tileSize;
  const furniture = map.furniture;
  const n = furniture.length;
  const heights = new Float64Array(n);
  const keep = new Uint8Array(n);
  const candidates: number[] = [];
  // Per-kind height of the `sprite`-class kinds (0 = not one), looked up once per kind rather than per item.
  const kindSprite = new Map<string, number>();
  for (let i = 0; i < n && input.sprites; i++) {
    const f = furniture[i]!;
    let h = kindSprite.get(f.kind);
    if (h === undefined) {
      h = spriteClassOf(f.kind) === 'sprite' ? kindHeight(f.kind) : 0;
      kindSprite.set(f.kind, h);
    }
    if (h === 0) continue;
    heights[i] = h;
    keep[i] = 1;
    candidates.push(i);
  }

  // Cap: tallest first, then northmost, then input order (a total order, so the result is deterministic).
  if (candidates.length > maxSprites) {
    const order = candidates.sort((a, b) => heights[b]! - heights[a]! || furniture[a]!.y + furniture[a]!.h - (furniture[b]!.y + furniture[b]!.h) || a - b);
    for (let k = Math.max(0, maxSprites); k < order.length; k++) keep[order[k]!] = 0;
  }
  const demoted = candidates.length > maxSprites ? candidates.length - Math.max(0, maxSprites) : 0;

  const sitInKind = new Map<string, boolean>();
  const baked: PlacedFurniture[] = [];
  const sprites: FurnitureSprite[] = [];
  const frames = new Map<string, FrameSpec>();
  const frameOf = (f: PlacedFurniture): { key: string; themeId: string } => {
    const themeId = themeIdAt(f.x, f.y);
    const key = planFrameKey(themeId, f);
    if (!frames.has(key)) {
      frames.set(key, { key, themeId, item: f, w: f.w * T + 2 * SPRITE_MARGIN.side, h: f.h * T + SPRITE_MARGIN.top + SPRITE_MARGIN.bottom });
    }
    return { key, themeId };
  };
  for (let i = 0; i < n; i++) {
    const f = furniture[i]!;
    const baseY = (f.y + f.h) * T;
    if (keep[i] === 1) {
      const { key, themeId } = frameOf(f);
      sprites.push({ item: f, frame: key, themeId, x: f.x * T - SPRITE_MARGIN.side, y: f.y * T - SPRITE_MARGIN.top, baseY, strip: null, height: heights[i]! });
      continue;
    }
    baked.push(f);
    let sitIn = sitInKind.get(f.kind);
    if (sitIn === undefined) sitInKind.set(f.kind, (sitIn = isSitInKind(f.kind)));
    if (!sitIn || !isSitInKind(f.kind)) continue;
    const px = Math.min(FRONT_STRIP_PX[f.kind][f.facing ?? 's'], f.h * T);
    if (px <= 0) continue;
    const { key, themeId } = frameOf(f);
    const strip = { x: f.x * T, y: baseY - px, w: f.w * T, h: px };
    sprites.push({ item: f, frame: `${key}#strip`, themeId, x: strip.x, y: strip.y, baseY, strip, height: 0 });
  }
  return { sprites, baked, frames, demoted };
}
