import type * as Phaser from 'phaser';

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
