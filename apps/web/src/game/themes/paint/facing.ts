import type * as Phaser from 'phaser';
import type { Facing } from '@tagconn/shared';
import type { FurnitureKind, PlacedFurniture, Rect } from '../../procgen/types';

// M16 F3 (docs/design/furnishing.md section 5.2): facing helpers shared by the style painters. A painter always draws the
// south-facing art; for the rotation-safe kinds (rects only, no text, no asymmetric detail) the style's dispatcher wraps it in
// `paintRotated` so e/n/w are the same art rotated about the footprint centre. `f.w`/`f.h` are already the rotated footprint.

/** Clockwise canvas rotation (radians, y down) that turns the south-facing frame into each facing. */
const ANGLE: Record<Facing, number> = { s: 0, e: -Math.PI / 2, n: Math.PI, w: Math.PI / 2 };

const facingOf = (f: PlacedFurniture): Facing => f.facing ?? 's';

/** The south-frame twin of a placed item: canonical (un-swapped) size, same centre, no facing, no wall overdraw. */
function southFrame(f: PlacedFurniture): PlacedFurniture {
  const swap = f.facing === 'e' || f.facing === 'w';
  const w = swap ? f.h : f.w;
  const h = swap ? f.w : f.h;
  const { facing: _facing, againstNorthWall: _wall, ...rest } = f;
  return { ...rest, x: f.x + f.w / 2 - w / 2, y: f.y + f.h / 2 - h / 2, w, h };
}

/** Draw `drawSouth` for the item's facing: as-is for `s`, otherwise the south-frame art rotated about the footprint centre
 *  (`g.save(); translateCanvas; rotateCanvas; ...; g.restore()`; Phaser records these as commands, so `generateTexture`
 *  honours them on WebGL and Canvas). */
export function paintRotated(
  g: Phaser.GameObjects.Graphics,
  f: PlacedFurniture,
  T: number,
  drawSouth: (g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number) => void,
): void {
  const facing = facingOf(f);
  if (facing === 's') return drawSouth(g, f, T);
  const cx = (f.x + f.w / 2) * T;
  const cy = (f.y + f.h / 2) * T;
  const south = southFrame(f);
  g.save();
  g.translateCanvas(cx, cy);
  g.rotateCanvas(ANGLE[facing]);
  g.translateCanvas(-cx, -cy);
  drawSouth(clampedTo(g, south, T), south, T);
  g.restore();
}

/** M17: the tall south art of a wall kind (a bookcase pokes 11 px above its footprint) would swing sideways when rotated and leave the
 *  sprite slot, so a rotated frame keeps its rects within `ROTATED_OVERDRAW_PX` of the footprint (the slot's side margin). */
const ROTATED_OVERDRAW_PX = 2;

/** `g` with `fillRect` clipped to the south frame's footprint plus `ROTATED_OVERDRAW_PX`; every other method is `g`'s own. */
function clampedTo(g: Phaser.GameObjects.Graphics, south: PlacedFurniture, T: number): Phaser.GameObjects.Graphics {
  const x0 = south.x * T - ROTATED_OVERDRAW_PX;
  const y0 = south.y * T - ROTATED_OVERDRAW_PX;
  const x1 = (south.x + south.w) * T + ROTATED_OVERDRAW_PX;
  const y1 = (south.y + south.h) * T + ROTATED_OVERDRAW_PX;
  return new Proxy(g, {
    get(target, prop) {
      if (prop === 'fillRect') {
        return (x: number, y: number, w: number, h: number) => {
          const cx0 = Math.max(x, x0);
          const cy0 = Math.max(y, y0);
          const cx1 = Math.min(x + w, x1);
          const cy1 = Math.min(y + h, y1);
          if (cx1 > cx0 && cy1 > cy0) target.fillRect(cx0, cy0, cx1 - cx0, cy1 - cy0);
          return target;
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Kinds whose art is rotation-safe (furnishing.md section 5.2): rects only, no text, no front face. The explicit-variant
 *  kinds (chair, armchair, sofa, booth: F6) and the fixed `s`-only kinds are not here. */
export const ROTATION_SAFE_KINDS: ReadonlySet<FurnitureKind> = new Set<FurnitureKind>([
  'table', 'reading-table', 'standing-table', 'rack', 'rack-row', 'bench', 'counter', 'shelf', 'shelf-stack', 'bookcase', 'cabinet',
  'filing-cabinet', 'crate', 'bin', 'supply-stack', 'coat-rack', 'board', 'notice-board', 'roster-board', 'lamp', 'plant',
]);

/** The style dispatchers' one-liner: rotation-safe kinds facing e/n/w go through `paintRotated`, everything else draws as-is. */
export function paintForFacing(
  g: Phaser.GameObjects.Graphics,
  f: PlacedFurniture,
  T: number,
  drawSouth: (g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number) => void,
): void {
  if (f.facing && f.facing !== 's' && ROTATION_SAFE_KINDS.has(f.kind)) paintRotated(g, f, T, drawSouth);
  else drawSouth(g, f, T);
}

/** Mirror only (`n` for kinds whose art is left-right symmetric): the south art flipped top-to-bottom about the centre. */
export function paintMirroredNS(
  g: Phaser.GameObjects.Graphics,
  f: PlacedFurniture,
  T: number,
  drawSouth: (g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number) => void,
): void {
  if (facingOf(f) !== 'n') return drawSouth(g, f, T);
  const cy = (f.y + f.h / 2) * T;
  const { facing: _facing, againstNorthWall: _wall, ...south } = f;
  g.save();
  g.translateCanvas(0, cy);
  g.scaleCanvas(1, -1);
  g.translateCanvas(0, -cy);
  drawSouth(g, south, T);
  g.restore();
}

/** Rect-recording harness support: where a rect recorded in the south frame lands once drawn for `facing`. `footprint` is the
 *  placed (already rotated) footprint in pixels; the rotation is about its centre. */
export function rotateRectForFacing(r: Rect, footprint: Rect, facing: Facing): Rect {
  if (facing === 's') return r;
  const cx = footprint.x + footprint.w / 2;
  const cy = footprint.y + footprint.h / 2;
  const a = ANGLE[facing];
  const cos = Math.round(Math.cos(a));
  const sin = Math.round(Math.sin(a));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]] as const) {
    const dx = px - cx;
    const dy = py - cy;
    xs.push(cx + dx * cos - dy * sin);
    ys.push(cy + dx * sin + dy * cos);
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
