import { generateHeroAppearance, HERO_ACCESSORIES, HERO_HATS, HERO_PROPS, heroSeed } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { paintHeroPreview } from './heroPreview';
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
