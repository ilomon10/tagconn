import { beforeEach, describe, expect, it, vi } from 'vitest';

// Character with a stub scene: every game object is a recording fake (texture key, flip, visibility, x, scaleX).
const fakes = vi.hoisted(() => {
  class Obj {
    x = 0;
    y = 0;
    scaleX = 1;
    scaleY = 1;
    visible = true;
    flipX = false;
    texture = { key: '', setFilter() {} };
    list: Obj[] = [];
    setTextureCalls = 0;
    input: unknown = null;
    constructor(_s?: unknown, x = 0, y = 0, key = '', list: Obj[] = []) {
      this.x = x;
      this.y = y;
      this.texture.key = key;
      this.list = list;
    }
    setTexture(k: string) {
      this.texture.key = k;
      this.setTextureCalls++;
      return this;
    }
    setVisible(v: boolean) {
      this.visible = v;
      return this;
    }
    setFlipX(v: boolean) {
      this.flipX = v;
      return this;
    }
    setPosition(x: number, y: number) {
      this.x = x;
      this.y = y;
      return this;
    }
    setScale(a: number, b?: number) {
      this.scaleX = a;
      this.scaleY = b ?? a;
      return this;
    }
    add(c: Obj | Obj[]) {
      this.list.push(...(Array.isArray(c) ? c : [c]));
      return this;
    }
    getIndex(c: Obj) {
      return this.list.indexOf(c);
    }
    moveTo(c: Obj, i: number) {
      this.list.splice(this.list.indexOf(c), 1);
      this.list.splice(i, 0, c);
      return this;
    }
    setInteractive() {
      return this;
    }
  }
  const handler: ProxyHandler<Obj> = {
    get(t, p, r) {
      if (p in t) return Reflect.get(t, p, r);
      return (..._a: unknown[]) => r; // any other setter (origin, tint, depth, alpha, rotation...) is a chainable no-op
    },
    set(t, p, v) {
      (t as unknown as Record<string | symbol, unknown>)[p] = v;
      return true;
    },
  };
  const make = (...a: ConstructorParameters<typeof Obj>) => new Proxy(new Obj(...a), handler);
  class Container extends Obj {
    constructor(scene: unknown, x?: number, y?: number) {
      super(scene, x, y);
      return new Proxy(this, handler);
    }
  }
  return { Obj, make, handler, Container };
});

vi.mock('phaser', () => {
  return {
    GameObjects: { Container: fakes.Container },
    Geom: { Rectangle: Object.assign(class { setTo() {} }, { Contains: () => true }) },
    Textures: { FilterMode: { LINEAR: 1, NEAREST: 0 } },
    Math: {},
  };
});

import { Character } from '../Character';
import type { Facing } from '../walkQueue';

type Fake = InstanceType<typeof fakes.Obj>;
const scene = {
  add: {
    image: (x: number, y: number, key: string) => fakes.make(undefined, x, y, key),
    container: (x: number, y: number, list: Fake[] = []) => fakes.make(undefined, x, y, '', [...list]),
    graphics: () => fakes.make(),
    text: () => fakes.make(),
    existing: () => undefined,
  },
  textures: { exists: () => true },
  make: {},
  tweens: { add: () => ({}) },
} as never;

const mk = () => {
  const c = new Character(scene, 'agent:t' as never, 100, 100);
  const parts = c as unknown as Record<'legs' | 'body_' | 'head' | 'hair' | 'upper' | 'badge' | 'handL' | 'cloak', Fake>;
  const anim = (now = 0) => (c as unknown as { animate(n: number): void }).animate(now);
  return { c, p: parts, anim };
};
const walkDir = (c: Character, f: Facing) => {
  const d = { n: [0, -50], s: [0, 50], e: [50, 0], w: [-50, 0] }[f]!;
  c.walkPoints([{ x: 100 + d[0]!, y: 100 + d[1]! }], false);
  c.update(0, 16, 40);
};

describe('Character views (M17)', () => {
  let h: ReturnType<typeof mk>;
  beforeEach(() => {
    h = mk();
  });
  const shown = () => [h.p.body_.texture.key, h.p.head.texture.key, h.p.upper.scaleX, h.p.legs.flipX] as const;

  it('walking east, west, north and south picks the right textures and flips', () => {
    walkDir(h.c, 'e');
    expect(shown()).toEqual(['ch-body-e', 'ch-head-e', 1, false]);
    expect(h.p.legs.texture.key).toMatch(/^ch-legs-e-\d$/);
    walkDir(h.c, 'w');
    expect(shown()).toEqual(['ch-body-e', 'ch-head-e', -1, true]);
    walkDir(h.c, 'n');
    expect(shown()).toEqual(['ch-body-n', 'ch-head-n', 1, false]);
    expect(h.p.legs.texture.key).toMatch(/^ch-legs-n-\d$/);
    walkDir(h.c, 's');
    expect(shown()).toEqual(['ch-body', 'ch-head', 1, false]);
    expect(h.p.legs.texture.key).toMatch(/^ch-legs-\d$/);
  });

  it('the back view hides the badge and draws the cloak over the body; the side view hides the far arm', () => {
    walkDir(h.c, 'n');
    expect(h.p.badge.visible).toBe(false);
    const order = h.p.upper.list;
    expect(order.indexOf(h.p.cloak)).toBe(order.indexOf(h.p.head) - 1);
    expect(order.indexOf(h.p.cloak)).toBeGreaterThan(order.indexOf(h.p.body_));
    walkDir(h.c, 'e');
    expect(h.p.handL.visible).toBe(false);
    expect(order.indexOf(h.p.cloak)).toBe(0);
    walkDir(h.c, 's');
    expect(h.p.badge.visible).toBe(true);
    expect(h.p.handL.visible).toBe(true);
  });

  it('hair follows the view and the hero hair style survives a view change', () => {
    h.c.setAppearance({ skin: 0xffffff, hair: 0x112233, hairStyle: 3 } as never);
    expect(h.p.hair.texture.key).toBe('ch-hair-3');
    walkDir(h.c, 'n');
    expect(h.p.hair.texture.key).toBe('ch-hair-3-n');
    h.c.setAppearance({ skin: 0xffffff, hair: 0x112233, hairStyle: 5 } as never);
    expect(h.p.hair.texture.key).toBe('ch-hair-5-n');
    walkDir(h.c, 'e');
    expect(h.p.hair.texture.key).toBe('ch-hair-5-e');
  });

  it('a seated character shows the chair view; standing idle returns to the front view', () => {
    (h.c as unknown as { seated: boolean; activity: string }).seated = true;
    (h.c as unknown as { activity: string }).activity = 'typing';
    h.c.setSeatFacing('n');
    h.anim();
    expect(shown()).toEqual(['ch-body-n', 'ch-head-n', 1, false]);
    expect(h.p.legs.texture.key).toBe('ch-legs-n-sit');
    h.c.setSeatFacing('w');
    h.anim();
    expect(shown()).toEqual(['ch-body-e', 'ch-head-e', -1, true]);
    expect(h.p.legs.texture.key).toBe('ch-legs-e-sit');
    h.c.setSeatFacing(null);
    h.anim();
    expect(shown()).toEqual(['ch-body', 'ch-head', 1, false]);
    (h.c as unknown as { seated: boolean }).seated = false;
    h.c.setSeatFacing('n');
    h.anim();
    expect(shown()).toEqual(['ch-body', 'ch-head', 1, false]);
  });

  it('standing with face() turns to profile toward the point', () => {
    h.c.face(50);
    h.anim();
    expect(shown()).toEqual(['ch-body-e', 'ch-head-e', -1, true]);
    h.c.face(150);
    h.anim();
    expect(shown()).toEqual(['ch-body-e', 'ch-head-e', 1, false]);
    h.c.face(null);
    h.anim();
    expect(shown()).toEqual(['ch-body', 'ch-head', 1, false]);
  });

  it('setFourDirections(false) never leaves the legacy keys and keeps the horizontal flip', () => {
    h.c.setFourDirections(false);
    for (const f of ['e', 'w', 'n', 's'] as const) {
      walkDir(h.c, f);
      expect(h.p.body_.texture.key).toBe('ch-body');
      expect(h.p.head.texture.key).toBe('ch-head');
      expect(h.p.legs.texture.key).toMatch(/^ch-legs-\d$/);
      expect(h.p.legs.flipX).toBe(false);
    }
    walkDir(h.c, 'w');
    expect(h.p.upper.scaleX).toBe(-1);
  });

  it('turning four directions off in a side view restores the front view', () => {
    walkDir(h.c, 'w');
    h.c.setFourDirections(false);
    expect(shown()).toEqual(['ch-body', 'ch-head', 1, false]);
  });

  it('turning four directions off and on again does not keep the legacy flip on the front view', () => {
    h.c.setFourDirections(false);
    h.c.face(50); // legacy flip: upper.scaleX = -1 while viewKey stays 's'
    h.anim();
    expect(h.p.upper.scaleX).toBe(-1);
    h.c.face(null);
    h.c.setFourDirections(true);
    h.anim();
    expect(shown()).toEqual(['ch-body', 'ch-head', 1, false]);
  });

  it('applies a view only on change', () => {
    walkDir(h.c, 'e');
    const before = h.p.body_.setTextureCalls + h.p.head.setTextureCalls + h.p.hair.setTextureCalls;
    for (let i = 0; i < 20; i++) h.c.update(i * 16, 16, 40);
    expect(h.p.body_.setTextureCalls + h.p.head.setTextureCalls + h.p.hair.setTextureCalls).toBe(before);
  });
});
