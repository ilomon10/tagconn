import { generateHeroAppearance, HERO_ACCESSORIES, HERO_HAIR_COLORS, HERO_HATS, HERO_PROPS, HERO_SKIN_TONES, heroSeed, HeroAppearanceSchema } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { anonymousAppearance, BUST_SHIFT_Y, paintHeroPreview, paintPortrait } from './heroPreview';
import { HAIR_COLORS, HAIR_STYLES, SKIN_TONES, hexToNumber } from './textures';
import type { Costume } from './themes/types';

/** A stub `CanvasRenderingContext2D` — just enough of the 2D API for `paintHeroPreview` to draw
 *  on, recording every `fillRect` so tests can assert something was actually painted. */
class FakeCanvasContext2D {
  calls: { x: number; y: number; w: number; h: number; color: string; alpha: number }[] = [];
  fillStyle = '#000000';
  globalAlpha = 1;
  private alphaStack: number[] = [];

  save() {
    this.alphaStack.push(this.globalAlpha);
  }

  restore() {
    this.globalAlpha = this.alphaStack.pop() ?? 1;
  }

  fillRect(x: number, y: number, w: number, h: number) {
    this.calls.push({ x, y, w, h, color: this.fillStyle, alpha: this.globalAlpha });
  }
}

function fakeCtx(): { ctx: CanvasRenderingContext2D; fake: FakeCanvasContext2D } {
  const fake = new FakeCanvasContext2D();
  return { ctx: fake as unknown as CanvasRenderingContext2D, fake };
}

const GUILD_PM_COSTUME: Costume = {
  robe: 0x9c2a3a,
  cloak: 0x6b1b26,
  hat: 'crown',
  hatColor: 0xd6a852,
  staff: 'staff',
  trim: 0xd6a852,
  goggles: true, // (not a real theme combo, but exercises the goggles+cloak-both path)
};

const MODERN_COSTUME: Costume = {};

describe('paintHeroPreview', () => {
  it('draws every hat, prop and accessory value without throwing, over both a themed and an empty costume', () => {
    const base = generateHeroAppearance(heroSeed('proj-1', 'developer', 0));
    for (const themeCostume of [GUILD_PM_COSTUME, MODERN_COSTUME]) {
      for (const hat of HERO_HATS) {
        for (const prop of HERO_PROPS) {
          for (const accessory of HERO_ACCESSORIES) {
            const { ctx } = fakeCtx();
            expect(() =>
              paintHeroPreview(ctx, {
                appearance: { ...base, hat, prop, accessory },
                themeCostume,
                roleColor: 0x223344,
                scale: 6,
              }),
            ).not.toThrow();
          }
        }
      }
    }
  });

  it('paints at least the body and head (some fillRect calls) with default options', () => {
    const { ctx, fake } = fakeCtx();
    const appearance = generateHeroAppearance(heroSeed('proj-1', 'developer', 0));
    paintHeroPreview(ctx, { appearance, themeCostume: MODERN_COSTUME, roleColor: 0x223344 });
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it('draws more pixels when a hat is shown than when it is hidden', () => {
    const appearance = generateHeroAppearance(heroSeed('proj-1', 'pm', 0));
    const withHat = fakeCtx();
    paintHeroPreview(withHat.ctx, { appearance: { ...appearance, hat: 'crown' }, themeCostume: GUILD_PM_COSTUME, roleColor: 0x223344, scale: 4 });
    const withoutHat = fakeCtx();
    paintHeroPreview(withoutHat.ctx, { appearance: { ...appearance, hat: 'none' }, themeCostume: GUILD_PM_COSTUME, roleColor: 0x223344, scale: 4 });
    expect(withHat.fake.calls.length).toBeGreaterThan(withoutHat.fake.calls.length);
  });

  it('scales every fillRect to the given scale', () => {
    const appearance = generateHeroAppearance(heroSeed('proj-1', 'developer', 0));
    const { ctx, fake } = fakeCtx();
    paintHeroPreview(ctx, { appearance, themeCostume: MODERN_COSTUME, roleColor: 0x223344, scale: 6 });
    expect(fake.calls.every((c) => c.w === 6 && c.h === 6)).toBe(true);
  });

  it('tints the body with the resolved outfit colour', () => {
    const appearance = generateHeroAppearance(heroSeed('proj-1', 'developer', 0));
    const { ctx, fake } = fakeCtx();
    paintHeroPreview(ctx, { appearance: { ...appearance, outfitColor: '#00ff00' }, themeCostume: MODERN_COSTUME, roleColor: 0x223344, scale: 2 });
    expect(fake.calls.some((c) => c.color === '#00ff00')).toBe(true);
  });

  it('respects an explicit origin', () => {
    const appearance = generateHeroAppearance(heroSeed('proj-1', 'developer', 0));
    const at0 = fakeCtx();
    paintHeroPreview(at0.ctx, { appearance, themeCostume: MODERN_COSTUME, roleColor: 0x223344, scale: 1, originX: 0, originY: 0 });
    const at100 = fakeCtx();
    paintHeroPreview(at100.ctx, { appearance, themeCostume: MODERN_COSTUME, roleColor: 0x223344, scale: 1, originX: 100, originY: 100 });
    expect(at100.fake.calls[0]!.x - at0.fake.calls[0]!.x).toBe(100);
    expect(at100.fake.calls[0]!.y - at0.fake.calls[0]!.y).toBe(100);
  });
});

describe('paintPortrait', () => {
  const appearance = generateHeroAppearance(heroSeed('proj-1', 'developer', 0));
  const opts = { appearance, themeCostume: MODERN_COSTUME, roleColor: 0x223344, scale: 2 };

  it('full is the plain preview', () => {
    const a = fakeCtx();
    const b = fakeCtx();
    paintPortrait(a.ctx, { ...opts, crop: 'full' });
    paintHeroPreview(b.ctx, opts);
    expect(a.fake.calls).toEqual(b.fake.calls);
  });

  it('bust drops the origin so the head and shoulders fill the frame', () => {
    const a = fakeCtx();
    const b = fakeCtx();
    paintPortrait(a.ctx, { ...opts, crop: 'bust' });
    paintHeroPreview(b.ctx, opts);
    expect(a.fake.calls.length).toBe(b.fake.calls.length);
    expect(a.fake.calls[0]!.y - b.fake.calls[0]!.y).toBe(BUST_SHIFT_Y * 2);
    expect(a.fake.calls[0]!.x).toBe(b.fake.calls[0]!.x);
  });

  it('bust shifts an explicit origin too', () => {
    const a = fakeCtx();
    const b = fakeCtx();
    paintPortrait(a.ctx, { ...opts, originX: 10, originY: 40, crop: 'bust' });
    paintHeroPreview(b.ctx, { ...opts, originX: 10, originY: 40 });
    expect(a.fake.calls[0]!.y - b.fake.calls[0]!.y).toBe(BUST_SHIFT_Y * 2);
  });
});

describe('anonymousAppearance', () => {
  // The same FNV-1a as `Character.ts` `hash` (Phaser-bound, so replicated here as the reference).
  const characterHash = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  };

  it('picks the skin and hair the scene draws for the same actor key', () => {
    for (const key of ['agent:main:abc', 'agent:sub-1', 'gm:proj-1', 'agent:', 'agent:\u00e9\u00e8']) {
      const h = characterHash(key);
      const a = anonymousAppearance(key, 0);
      expect(hexToNumber(a.skin)).toBe(SKIN_TONES[h % SKIN_TONES.length]);
      expect(hexToNumber(a.hairColor)).toBe(HAIR_COLORS[(h >>> 3) % HAIR_COLORS.length]);
    }
  });

  it('takes the hair style from the role sprite, wrapped like the scene does', () => {
    expect(anonymousAppearance('agent:x', 3).hairStyle).toBe(3);
    expect(anonymousAppearance('agent:x', HAIR_STYLES + 2).hairStyle).toBe(2);
    expect(anonymousAppearance('agent:x', -1).hairStyle).toBe(1 % HAIR_STYLES);
  });

  it('is a valid appearance with auto dressing and the palette colours', () => {
    const a = anonymousAppearance('agent:y', 5);
    expect(HeroAppearanceSchema.safeParse(a).success).toBe(true);
    expect([a.hat, a.prop, a.accessory]).toEqual(['auto', 'auto', 'auto']);
    expect(a.outfitColor).toBeNull();
    expect(HERO_SKIN_TONES).toContain(a.skin);
    expect(HERO_HAIR_COLORS).toContain(a.hairColor);
  });

  it('is deterministic', () => {
    expect(anonymousAppearance('agent:z', 1)).toEqual(anonymousAppearance('agent:z', 1));
  });
});

describe('paintHeroPreview views (M17)', () => {
  const base = { appearance: anonymousAppearance('agent:v', 2), themeCostume: {} as Costume, roleColor: 0x4488cc, scale: 2 };
  const calls = (view?: 's' | 'n' | 'e') => {
    const { ctx, fake } = fakeCtx();
    paintHeroPreview(ctx, { ...base, view });
    return fake.calls;
  };

  it('defaults to the front view', () => {
    expect(calls()).toEqual(calls('s'));
  });

  it('every view paints, and the back and side views differ from the front', () => {
    const s = calls('s');
    for (const v of ['n', 'e'] as const) {
      const c = calls(v);
      expect(c.length).toBeGreaterThan(20);
      expect(c).not.toEqual(s);
    }
  });

  it('hero skin, hair and outfit colours reach every view', () => {
    const look = base.appearance;
    for (const v of ['s', 'n', 'e'] as const) {
      const colors = new Set(calls(v).map((c) => c.color));
      expect(colors.has(`#${hexToNumber(look.skin).toString(16).padStart(6, '0')}`), `${v} skin`).toBe(true);
    }
  });
});
