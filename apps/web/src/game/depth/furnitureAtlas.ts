// M17 D1: paints the unique furniture frames of one theme into atlas pages (docs/design/depth-25d.md section 3.3).
import type * as Phaser from 'phaser';
import type { PlacedFurniture } from '../procgen/types';
import type { ThemeDefinition } from '../themes/types';
import { packFrames } from './pack';
import { ATLAS_MAX_OWN_TEXTURES, FRONT_STRIP_PX, SPRITE_MARGIN, isSitInKind } from './tables';
import type { FrameSpec, PackedFrame } from './types';

export interface FurnitureAtlas {
  themeId: string;
  pageKeys: string[];
  frames: Map<string, PackedFrame>;
  /** The texture key holding a frame (or its `#strip`): the page, or the frame's own texture when its painter overshoots its slot. */
  textureOf(frame: string): string | undefined;
  /** Frame keys left out (page cap or own-texture cap); the caller must bake those items into the base texture instead. */
  demoted: ReadonlySet<string>;
  destroy(): void;
}
export const atlasKey = (themeId: string, page: number, generation: number) => `furniture-atlas-${themeId}-${page}-${generation}`;

type Matrix = [number, number, number, number, number, number];
const mul = (p: Matrix, q: Matrix): Matrix => [
  p[0] * q[0] + p[2] * q[1],
  p[1] * q[0] + p[3] * q[1],
  p[0] * q[2] + p[2] * q[3],
  p[1] * q[2] + p[3] * q[3],
  p[0] * q[4] + p[2] * q[5] + p[4],
  p[1] * q[4] + p[3] * q[5] + p[5],
];
const BENIGN = new Set(['fillStyle', 'lineStyle', 'save', 'restore', 'translateCanvas', 'rotateCanvas', 'scaleCanvas']);

interface Recording {
  ops: [string, unknown[]][];
  /** World-space bounds of everything drawn (transform-aware); `unknown` when a draw call the probe cannot bound was used. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  unknown: boolean;
}

/** Runs a painter against a recording stand-in for `Graphics`: the commands (replayed onto the page) and where they land. */
function recordPaint(paint: (g: Phaser.GameObjects.Graphics) => void): Recording {
  const rec: Recording = { ops: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, unknown: false };
  let m: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let lineW = 1;
  const addRect = (x: number, y: number, w: number, h: number, pad = 0) => {
    for (const [px, py] of [[x - pad, y - pad], [x + w + pad, y - pad], [x - pad, y + h + pad], [x + w + pad, y + h + pad]] as const) {
      const wx = m[0] * px + m[2] * py + m[4];
      const wy = m[1] * px + m[3] * py + m[5];
      rec.minX = Math.min(rec.minX, wx);
      rec.maxX = Math.max(rec.maxX, wx);
      rec.minY = Math.min(rec.minY, wy);
      rec.maxY = Math.max(rec.maxY, wy);
    }
  };
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        return (...a: number[]) => {
          rec.ops.push([prop, a]);
          const [p, q, r, s, t, u] = a;
          switch (prop) {
            case 'save': stack.push([...m] as Matrix); break;
            case 'restore': m = stack.pop() ?? m; break;
            case 'translateCanvas': m = mul(m, [1, 0, 0, 1, p ?? 0, q ?? 0]); break;
            case 'rotateCanvas': m = mul(m, [Math.cos(p ?? 0), Math.sin(p ?? 0), -Math.sin(p ?? 0), Math.cos(p ?? 0), 0, 0]); break;
            case 'scaleCanvas': m = mul(m, [p ?? 1, 0, 0, q ?? 1, 0, 0]); break;
            case 'lineStyle': lineW = p ?? 1; break;
            case 'fillRect': addRect(p ?? 0, q ?? 0, r ?? 0, s ?? 0); break;
            case 'fillCircle': addRect((p ?? 0) - (r ?? 0), (q ?? 0) - (r ?? 0), 2 * (r ?? 0), 2 * (r ?? 0)); break;
            case 'strokeCircle': addRect((p ?? 0) - (r ?? 0), (q ?? 0) - (r ?? 0), 2 * (r ?? 0), 2 * (r ?? 0), lineW / 2); break;
            case 'fillEllipse': addRect((p ?? 0) - (r ?? 0) / 2, (q ?? 0) - (s ?? 0) / 2, r ?? 0, s ?? 0); break;
            case 'strokeEllipse': addRect((p ?? 0) - (r ?? 0) / 2, (q ?? 0) - (s ?? 0) / 2, r ?? 0, s ?? 0, lineW / 2); break;
            case 'fillTriangle': {
              const xs = [p ?? 0, r ?? 0, t ?? 0];
              const ys = [q ?? 0, s ?? 0, u ?? 0];
              addRect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
              break;
            }
            default: if (!BENIGN.has(prop)) rec.unknown = true;
          }
          return proxy;
        };
      },
    },
  );
  paint(proxy as Phaser.GameObjects.Graphics);
  return rec;
}

function replay(g: Phaser.GameObjects.Graphics, ops: Recording['ops']): void {
  const target = g as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const [name, args] of ops) target[name]!(...args);
}

/** True when everything the painter drew lies inside its slot, so it cannot touch a neighbouring frame. */
function fitsSlot(rec: Recording, item: PlacedFurniture, T: number): boolean {
  if (rec.unknown) return false;
  if (rec.ops.length === 0 || rec.minX === Infinity) return true;
  const eps = 1e-6;
  const x0 = item.x * T - SPRITE_MARGIN.side;
  const y0 = item.y * T - SPRITE_MARGIN.top;
  const x1 = (item.x + item.w) * T + SPRITE_MARGIN.side;
  const y1 = (item.y + item.h) * T + SPRITE_MARGIN.bottom;
  return rec.minX >= x0 - eps && rec.minY >= y0 - eps && rec.maxX <= x1 + eps && rec.maxY <= y1 + eps;
}

/** One `make.graphics` per page: for each frame `g.save(); g.translateCanvas(dx, dy); theme.paintFurniture(g, spec.item, T); g.restore()`,
 *  then `g.generateTexture(pageKey, w, h)` (transparent where nothing was drawn) and `texture.add(frameKey, 0, x, y, w, h)` for every
 *  frame and `texture.add(frameKey + '#strip', …)` for sit-in frames (strip rect from `FRONT_STRIP_PX`). `generation` makes keys
 *  unique across rebuilds so an in-flight image never points at a removed texture; `destroy()` removes the pages.
 *  A painter that overshoots its slot (so it would bleed into a neighbour) gets a texture of its own instead of a page slot, which
 *  clips it to the slot (at most `ATLAS_MAX_OWN_TEXTURES`, then the frame is demoted like a page-cap overflow, see `demoted`); `textureOf` says where each frame lives. */
export function buildFurnitureAtlas(scene: Phaser.Scene, theme: ThemeDefinition, frames: readonly FrameSpec[], T: number, generation: number): FurnitureAtlas {
  const start = import.meta.env.DEV ? performance.now() : 0;
  const layout = packFrames(frames);
  const allKeys = layout.pages.map((_p, i) => atlasKey(theme.id, i, generation));
  /** Pages that got a texture: a page whose frames all fell back to textures of their own is never generated. */
  const pageKeys: string[] = [];
  const owned: string[] = [];
  const where = new Map<string, string>();
  const demoted = new Set<string>(layout.demoted);
  const gs: Phaser.GameObjects.Graphics[] = [];
  const live = new Set<Phaser.GameObjects.Graphics>();
  const makeGraphics = () => {
    const g = scene.make.graphics({ x: 0, y: 0 }, false);
    live.add(g);
    return g;
  };
  const release = (g: Phaser.GameObjects.Graphics) => {
    if (live.delete(g)) g.destroy();
  };
  const used = layout.pages.map(() => 0);

  /** Frame rects to register once the page textures exist: [texture key, frame name, x, y, w, h]. */
  const adds: [string, string, number, number, number, number][] = [];
  const own: { key: string; rec: Recording; spec: FrameSpec }[] = [];
  try {
    layout.pages.forEach(() => gs.push(makeGraphics()));

    for (const spec of frames) {
      const slot = layout.frames.get(spec.key);
      if (!slot) continue;
      const rec = recordPaint((g) => theme.paintFurniture(g, spec.item, T));
      const fx = spec.item.x * T;
      const fy = spec.item.y * T;
      const fw = spec.item.w * T;
      const fh = spec.item.h * T;
      let tex = allKeys[slot.page]!;
      let ox = slot.x;
      let oy = slot.y;
      if (fitsSlot(rec, spec.item, T)) {
        const g = gs[slot.page]!;
        used[slot.page]!++;
        g.save();
        g.translateCanvas(ox - (fx - SPRITE_MARGIN.side), oy - (fy - SPRITE_MARGIN.top));
        replay(g, rec.ops);
        g.restore();
      } else if (own.length >= ATLAS_MAX_OWN_TEXTURES) {
        demoted.add(spec.key);
        continue;
      } else {
        tex = `${allKeys[slot.page]!}-x${own.length}`;
        ox = 0;
        oy = 0;
        own.push({ key: tex, rec, spec });
      }
      adds.push([tex, spec.key, ox, oy, spec.w, spec.h]);
      where.set(spec.key, tex);
      const px = isSitInKind(spec.item.kind) ? Math.min(FRONT_STRIP_PX[spec.item.kind][spec.item.facing ?? 's'], fh) : 0;
      if (px > 0) {
        adds.push([tex, `${spec.key}#strip`, ox + SPRITE_MARGIN.side, oy + SPRITE_MARGIN.top + fh - px, fw, px]);
        where.set(`${spec.key}#strip`, tex);
      }
    }
    layout.pages.forEach((p, i) => {
      if (used[i] === 0) return release(gs[i]!);
      gs[i]!.generateTexture(allKeys[i]!, p.w, p.h);
      release(gs[i]!);
      pageKeys.push(allKeys[i]!);
      owned.push(allKeys[i]!);
    });
    for (const o of own) {
      const g = makeGraphics();
      const { item } = o.spec;
      g.save();
      g.translateCanvas(SPRITE_MARGIN.side - item.x * T, SPRITE_MARGIN.top - item.y * T);
      replay(g, o.rec.ops);
      g.restore();
      g.generateTexture(o.key, o.spec.w, o.spec.h);
      release(g);
      owned.push(o.key);
    }
    for (const [tex, name, x, y, w, h] of adds) scene.textures.get(tex).add(name, 0, x, y, w, h);
  } catch (err) {
    // A painter threw: drop the textures made so far (the caller never gets an atlas to destroy).
    for (const key of owned.splice(0)) if (scene.textures.exists(key)) scene.textures.remove(key);
    throw err;
  } finally {
    for (const g of [...live]) release(g);
  }

  if (import.meta.env.DEV) {
    const dims = layout.pages.map((p) => `${p.w}x${p.h}`).join(', ');
    // eslint-disable-next-line no-console -- intentional one-line dev perf log, not app logging.
    console.debug(`[depth] atlas ${theme.id}: ${frames.length} frames, ${dims || 'none'} (${pageKeys.length} pages, ${own.length} own) in ${(performance.now() - start).toFixed(1)} ms`);
  }
  return {
    themeId: theme.id,
    pageKeys,
    frames: layout.frames,
    textureOf: (frame) => where.get(frame),
    demoted,
    destroy() {
      for (const key of owned.splice(0)) if (scene.textures.exists(key)) scene.textures.remove(key);
      where.clear();
    },
  };
}
