import type * as Phaser from 'phaser';
import type { FurnitureKind, PlacedFurniture } from '../../procgen/types';
import { rotateRectForFacing } from '../paint/facing';

/** A stub `Graphics` that records every draw call (method names, into `calls`) instead of touching a real canvas. */
export function makeStubGraphics(calls: string[] = []): { g: Phaser.GameObjects.Graphics; calls: string[] } {
  const methods = [
    'fillStyle',
    'fillRect',
    'fillCircle',
    'fillEllipse',
    'fillTriangle',
    'lineStyle',
    'strokeCircle',
    'strokeEllipse',
    'save',
    'restore',
    'translateCanvas',
    'rotateCanvas',
    'scaleCanvas',
    'generateTexture',
    'destroy',
  ] as const;
  const g: Record<string, (...args: unknown[]) => unknown> = {};
  for (const m of methods) g[m] = (..._args: unknown[]) => (calls.push(m), g);
  return { g: g as unknown as Phaser.GameObjects.Graphics, calls };
}

/** A stub `Image`/`Container` chain: every setter is a no-op that returns `this`, and lifecycle
 *  hooks (`once`) are recorded so `autoClean`-style destroy handlers can still be exercised. */
function makeStubGameObject(kind: string): Record<string, unknown> {
  const obj: Record<string, unknown> = { kind, x: 0, y: 0, children: [] as unknown[] };
  const chain =
    (name: string) =>
    (...args: unknown[]) => {
      if (name === 'setPosition') {
        obj.x = args[0];
        obj.y = args[1];
      }
      return obj;
    };
  for (const m of [
    'setOrigin',
    'setDepth',
    'setAlpha',
    'setScale',
    'setTint',
    'setBlendMode',
    'setAngle',
    'setPosition',
    'setFlipX',
    'setVisible',
  ]) {
    obj[m] = chain(m);
  }
  obj.add = (children: unknown) => {
    (obj.children as unknown[]).push(...(Array.isArray(children) ? children : [children]));
    return obj;
  };
  obj.once = (_event: string, cb: () => void) => {
    (obj.destroyListeners ??= [] as (() => void)[]);
    (obj.destroyListeners as (() => void)[]).push(cb);
    return obj;
  };
  obj.destroy = () => {
    for (const cb of (obj.destroyListeners as (() => void)[] | undefined) ?? []) cb();
  };
  return obj;
}

export interface RecordedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A stub `Graphics` that records every `fillRect` call's bounds (M8 8p: the appliance/back-wall
 * painter bounds tests need actual pixel rects, not just call counts). Other draw methods are
 * no-ops; every appliance/back-wall/wall-decor painter in this wave draws with `rectFn` only.
 */
export function makeBoundsGraphics(): { g: Phaser.GameObjects.Graphics; rects: RecordedRect[] } {
  const rects: RecordedRect[] = [];
  const g: Record<string, (...args: unknown[]) => unknown> = {};
  const methods = [
    'fillStyle',
    'fillCircle',
    'fillEllipse',
    'fillTriangle',
    'lineStyle',
    'strokeCircle',
    'strokeEllipse',
    'generateTexture',
    'destroy',
  ] as const;
  for (const m of methods) g[m] = (..._args: unknown[]) => g;
  g.fillRect = (...args: unknown[]) => {
    const [x, y, w, h] = args as number[];
    rects.push({ x: x!, y: y!, w: w!, h: h! });
    return g;
  };
  return { g: g as unknown as Phaser.GameObjects.Graphics, rects };
}

export interface FakeScene {
  scene: Phaser.Scene;
  tweenCount: () => number;
  imageCount: () => number;
  /** Every `fillRect` of every `make.graphics()` in call order; filled only with `recordRects` (M15). */
  rects: RecordedRect[];
  /** Every draw-method name of every `make.graphics()` in call order (`makeStubGraphics` `calls`); with
   *  `recordRects` only. Lets a test compare two whole command streams, not just their rects. */
  calls: string[];
}

export interface FakeSceneOptions {
  /** Record the `fillRect` bounds and method names of the graphics the scene makes (M15: the dual pass
   *  "off = byte-identical" and perf-count tests). Off by default: the stubs then only count calls. */
  recordRects?: boolean;
}

/** A minimal fake `Phaser.Scene` covering exactly what `renderTheme.ts`, `guild.ts` and `modern.ts`
 *  call: `make.graphics`, `textures.exists/remove`, `add.image/container`, and `tweens.add`. */
export function makeFakeScene(opts: FakeSceneOptions = {}): FakeScene {
  const textureKeys = new Set<string>();
  let tweens = 0;
  let images = 0;
  const rects: RecordedRect[] = [];
  const allCalls: string[] = [];
  const scene = {
    make: {
      graphics: () => {
        const { g } = makeStubGraphics(opts.recordRects ? allCalls : []);
        const raw = g as unknown as Record<string, (...args: unknown[]) => unknown>;
        const original = raw.generateTexture!;
        raw.generateTexture = (...args: unknown[]) => {
          textureKeys.add(args[0] as string);
          return original(...args);
        };
        if (opts.recordRects) {
          const originalFillRect = raw.fillRect!;
          raw.fillRect = (...args: unknown[]) => {
            const [x, y, w, h] = args as number[];
            rects.push({ x: x!, y: y!, w: w!, h: h! });
            return originalFillRect(...args);
          };
        }
        return g;
      },
    },
    textures: {
      exists: (key: string) => textureKeys.has(key),
      remove: (key: string) => textureKeys.delete(key),
    },
    add: {
      image: (..._args: unknown[]) => {
        images++;
        return makeStubGameObject('image');
      },
      container: (..._args: unknown[]) => makeStubGameObject('container'),
    },
    tweens: {
      add: (_config: unknown) => {
        tweens++;
        return makeStubGameObject('tween');
      },
      killTweensOf: (_targets: unknown) => undefined,
    },
  };
  return {
    scene: scene as unknown as Phaser.Scene,
    tweenCount: () => tweens,
    imageCount: () => images,
    rects,
    calls: allCalls,
  };
}

/** One recorded draw call: method name plus its numeric/other args (colours and alphas included). */
export type RecordedCommand = [string, ...unknown[]];

/**
 * M16 F3 rect-recording harness: records the FULL command stream (for byte-identity snapshots) and the pixel bounds of
 * every filled shape (`fillRect`, `fillCircle`, `fillEllipse`, `fillTriangle`) so the bounds tests also see painters that
 * draw circles. Rects are the untransformed rects the painter asked for (a rotated painter's canvas transform is applied
 * by the test with `rotateRectForFacing`).
 */
export function makeCommandGraphics(): { g: Phaser.GameObjects.Graphics; rects: RecordedRect[]; commands: RecordedCommand[] } {
  const rects: RecordedRect[] = [];
  const commands: RecordedCommand[] = [];
  const g: Record<string, (...args: unknown[]) => unknown> = {};
  const noop = ['fillStyle', 'lineStyle', 'strokeCircle', 'strokeEllipse', 'generateTexture', 'destroy', 'save', 'restore', 'translateCanvas', 'rotateCanvas', 'scaleCanvas'];
  for (const m of noop) g[m] = (...args: unknown[]) => (commands.push([m, ...args]), g);
  g.fillRect = (...args: unknown[]) => {
    const [x, y, w, h] = args as number[];
    commands.push(['fillRect', ...args]);
    rects.push({ x: x!, y: y!, w: w!, h: h! });
    return g;
  };
  g.fillCircle = (...args: unknown[]) => {
    const [x, y, r] = args as number[];
    commands.push(['fillCircle', ...args]);
    rects.push({ x: x! - r!, y: y! - r!, w: 2 * r!, h: 2 * r! });
    return g;
  };
  g.fillEllipse = (...args: unknown[]) => {
    const [x, y, w, h] = args as number[];
    commands.push(['fillEllipse', ...args]);
    rects.push({ x: x! - w! / 2, y: y! - h! / 2, w: w!, h: h! });
    return g;
  };
  g.fillTriangle = (...args: unknown[]) => {
    const [x1, y1, x2, y2, x3, y3] = args as number[];
    commands.push(['fillTriangle', ...args]);
    const minX = Math.min(x1!, x2!, x3!);
    const minY = Math.min(y1!, y2!, y3!);
    rects.push({ x: minX, y: minY, w: Math.max(x1!, x2!, x3!) - minX, h: Math.max(y1!, y2!, y3!) - minY });
    return g;
  };
  return { g: g as unknown as Phaser.GameObjects.Graphics, rects, commands };
}

/** Footprints that exercise half-tile sizes (docs/design/furnishing.md section 5.1). */
export const fractionalFootprints = [
  { w: 1.5, h: 1 },
  { w: 2.5, h: 1 },
  { w: 1, h: 1.5 },
  { w: 2.5, h: 2.5 },
] as const;

/** Integer footprints the byte-identity snapshot covers (the sizes recipes place today). */
export const integerFootprints = [
  { w: 1, h: 1 },
  { w: 2, h: 1 },
  { w: 1, h: 2 },
  { w: 2, h: 2 },
  { w: 3, h: 1 },
  { w: 1, h: 3 },
  { w: 4, h: 1 },
  { w: 3, h: 2 },
] as const;

export interface Overshoot {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** How far (px, >= 0) the union of `rects` pokes past each side of the footprint `f` (tile units, at tile size `T`). */
export function overshootOf(rects: readonly RecordedRect[], f: { x: number; y: number; w: number; h: number }, T: number): Overshoot {
  const o: Overshoot = { l: 0, t: 0, r: 0, b: 0 };
  for (const r of rects) {
    o.l = Math.max(o.l, f.x * T - r.x);
    o.t = Math.max(o.t, f.y * T - r.y);
    o.r = Math.max(o.r, r.x + r.w - (f.x + f.w) * T);
    o.b = Math.max(o.b, r.y + r.h - (f.y + f.h) * T);
  }
  return o;
}

type FurniturePainter = (g: Phaser.GameObjects.Graphics, f: PlacedFurniture, T: number) => void;
const SIDES = ['l', 't', 'r', 'b'] as const;
const merge = (a: Overshoot, b: Overshoot): Overshoot => ({ l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) });

function record(paint: FurniturePainter, f: PlacedFurniture, T: number): RecordedRect[] {
  const { g, rects } = makeCommandGraphics();
  paint(g, f, T);
  return rects;
}

/**
 * M16 F3 bounds check (furnishing.md section 5.1) for one painter: at every size in {1, 1.5, 2, 2.5}^2 the art must poke past
 * the footprint no further than the same painter does at the integer sizes bracketing it (floor/ceil per axis, min 1). Today's
 * integer art already overhangs by a px or two (shadows, posts, monitors against a wall), so the reference is the painter's own
 * integer behaviour, not zero: what this catches is a per-tile loop drawing a whole extra tile past a half-tile footprint.
 * Returns human-readable failures (empty = ok).
 */
export function fractionalBoundsFailures(paint: FurniturePainter, kind: FurnitureKind, T = 16): string[] {
  const fails = new Set<string>();
  const sizes = [1, 1.5, 2, 2.5];
  for (const against of [false, true]) {
    for (let variant = 0; variant < 4; variant++) {
      const place = (w: number, h: number): PlacedFurniture => ({ x: 2, y: 5, w, h, kind, blocking: true, roomId: 'r1', roomType: 'desks', variant, againstNorthWall: against });
      for (const w of sizes) {
        for (const h of sizes) {
          const f = place(w, h);
          const got = overshootOf(record(paint, f, T), f, T);
          let ref: Overshoot = { l: 0, t: 0, r: 0, b: 0 };
          for (const iw of new Set([Math.floor(w), Math.ceil(w)]))
            for (const ih of new Set([Math.floor(h), Math.ceil(h)])) {
              const fi = place(iw, ih);
              ref = merge(ref, overshootOf(record(paint, fi, T), fi, T));
            }
          for (const s of SIDES) if (got[s] > ref[s] + 1e-9) fails.add(`${kind} ${w}x${h}${against ? ' north' : ''}: ${s} overshoot ${got[s]} > ${ref[s]}`);
        }
      }
    }
  }
  return [...fails];
}

/**
 * Facing check for the rotation-safe kinds: drawn facing e/n/w (rotated footprint) the art, rotated back through
 * `rotateRectForFacing`, stays within the south-frame overshoot at the canonical size on every side.
 */
export function rotatedBoundsFailures(paint: FurniturePainter, kind: FurnitureKind, T = 16): string[] {
  const fails: string[] = [];
  for (const { w, h } of [{ w: 1, h: 1 }, { w: 2, h: 1 }, { w: 1.5, h: 1 }, { w: 2.5, h: 1.5 }]) {
    const base: PlacedFurniture = { x: 2, y: 5, w, h, kind, blocking: true, roomId: 'r1', roomType: 'desks', variant: 1 };
    const south = overshootOf(record(paint, base, T), base, T);
    const limit = Math.max(south.l, south.t, south.r, south.b);
    for (const facing of ['n', 'e', 'w'] as const) {
      const swap = facing !== 'n';
      const f: PlacedFurniture = { ...base, w: swap ? h : w, h: swap ? w : h, facing };
      const px = { x: f.x * T, y: f.y * T, w: f.w * T, h: f.h * T };
      const rotated = record(paint, f, T).map((r) => rotateRectForFacing(r, px, facing));
      const got = overshootOf(rotated, f, T);
      for (const s of SIDES) if (got[s] > limit + 1e-9) fails.push(`${kind} ${facing} ${w}x${h}: ${s} overshoot ${got[s]} > ${limit}`);
    }
  }
  return fails;
}
