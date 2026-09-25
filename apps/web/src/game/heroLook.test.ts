import type { HeroAppearance } from '@tagconn/shared';
import { generateHeroAppearance, heroSeed } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { resolveHeroCostume } from './heroLook';
import type { Costume } from './themes/types';

const ROLE_COLOR = 0x223344; // an arbitrary role colour, distinct from every theme value below

const GUILD_DEVELOPER_COSTUME: Costume = {
  robe: 0x6b4a2c,
  hat: 'none',
  staff: 'hammer',
  trim: 0xb5895a,
  goggles: true,
};

const GUILD_PM_COSTUME: Costume = {
  robe: 0x9c2a3a,
  cloak: 0x6b1b26,
  hat: 'crown',
  hatColor: 0xd6a852,
  staff: 'staff',
  trim: 0xd6a852,
};

const MODERN_COSTUME: Costume = {}; // every role under `modern` (docs: "nothing under modern")

/** A fully-explicit base appearance (no `auto`/null fields), so a single test only varies what it names. */
function baseAppearance(overrides: Partial<HeroAppearance> = {}): HeroAppearance {
  return {
    skin: '#f5c89a',
    hairStyle: 2,
    hairColor: '#3b2a20',
    outfitColor: null,
    hat: 'auto',
    hatColor: null,
    prop: 'auto',
    accessory: 'auto',
    accessoryColor: null,
    ...overrides,
  };
}

describe('resolveHeroCostume: skin, hair, outfit', () => {
  it('resolves skin and hair to their numeric tints, and passes hairStyle through', () => {
    const a = baseAppearance({ skin: '#e3ab7c', hairColor: '#8d3b1f', hairStyle: 4 });
    const r = resolveHeroCostume(MODERN_COSTUME, a, ROLE_COLOR);
    expect(r.skin).toBe(0xe3ab7c);
    expect(r.hair).toBe(0x8d3b1f);
    expect(r.hairStyle).toBe(4);
  });

  it('null outfitColor keeps the theme robe (the role colour, docs section 3)', () => {
    const a = baseAppearance({ outfitColor: null });
    const r = resolveHeroCostume(GUILD_DEVELOPER_COSTUME, a, ROLE_COLOR);
    expect(r.outfit).toBe(GUILD_DEVELOPER_COSTUME.robe);
    expect(r.costume.robe).toBe(GUILD_DEVELOPER_COSTUME.robe);
  });

  it('null outfitColor falls back further to roleColor when the theme has no robe (modern)', () => {
    const a = baseAppearance({ outfitColor: null });
    const r = resolveHeroCostume(MODERN_COSTUME, a, ROLE_COLOR);
    expect(r.outfit).toBe(ROLE_COLOR);
  });

  it('an explicit outfitColor overrides the theme robe', () => {
    const a = baseAppearance({ outfitColor: '#123456' });
    const r = resolveHeroCostume(GUILD_DEVELOPER_COSTUME, a, ROLE_COLOR);
    expect(r.outfit).toBe(0x123456);
    expect(r.costume.robe).toBe(0x123456);
  });
});

describe('resolveHeroCostume: hat auto/none/explicit', () => {
  it('auto keeps the theme hat for the role', () => {
    const r = resolveHeroCostume(GUILD_PM_COSTUME, baseAppearance({ hat: 'auto' }), ROLE_COLOR);
    expect(r.costume.hat).toBe('crown');
  });

  it('auto is none when the theme gives none for the role (developer) or nothing at all (modern)', () => {
    expect(resolveHeroCostume(GUILD_DEVELOPER_COSTUME, baseAppearance({ hat: 'auto' }), ROLE_COLOR).costume.hat).toBe('none');
    expect(resolveHeroCostume(MODERN_COSTUME, baseAppearance({ hat: 'auto' }), ROLE_COLOR).costume.hat).toBe('none');
  });

  it('none omits the hat even when the theme has one', () => {
    const r = resolveHeroCostume(GUILD_PM_COSTUME, baseAppearance({ hat: 'none' }), ROLE_COLOR);
    expect(r.costume.hat).toBe('none');
    expect(r.costume.hatColor).toBeUndefined();
  });

  it('an explicit hat overrides the theme hat', () => {
    const r = resolveHeroCostume(GUILD_PM_COSTUME, baseAppearance({ hat: 'wizard' }), ROLE_COLOR);
    expect(r.costume.hat).toBe('wizard');
  });

  it('hatColor: explicit > theme hat colour > outfit colour', () => {
    const explicit = resolveHeroCostume(GUILD_PM_COSTUME, baseAppearance({ hat: 'crown', hatColor: '#00ff00' }), ROLE_COLOR);
    expect(explicit.costume.hatColor).toBe(0x00ff00);

    const themed = resolveHeroCostume(GUILD_PM_COSTUME, baseAppearance({ hat: 'crown', hatColor: null }), ROLE_COLOR);
    expect(themed.costume.hatColor).toBe(GUILD_PM_COSTUME.hatColor);

    const outfitFallback = resolveHeroCostume(GUILD_DEVELOPER_COSTUME, baseAppearance({ hat: 'wizard', hatColor: null }), ROLE_COLOR);
    expect(outfitFallback.costume.hatColor).toBe(outfitFallback.outfit);
    expect(outfitFallback.costume.hatColor).toBe(GUILD_DEVELOPER_COSTUME.robe);
  });
});

describe('resolveHeroCostume: prop auto/none/explicit', () => {
  it('auto keeps the theme staff for the role, including an explicit theme none', () => {
    expect(resolveHeroCostume(GUILD_PM_COSTUME, baseAppearance({ prop: 'auto' }), ROLE_COLOR).costume.staff).toBe('staff');
    expect(resolveHeroCostume({ staff: 'none' }, baseAppearance({ prop: 'auto' }), ROLE_COLOR).costume.staff).toBe('none');
    expect(resolveHeroCostume(MODERN_COSTUME, baseAppearance({ prop: 'auto' }), ROLE_COLOR).costume.staff).toBe('none');
  });

  it('none omits the prop even when the theme has one', () => {
    expect(resolveHeroCostume(GUILD_PM_COSTUME, baseAppearance({ prop: 'none' }), ROLE_COLOR).costume.staff).toBe('none');
  });

  it('an explicit prop overrides the theme staff', () => {
    expect(resolveHeroCostume(GUILD_PM_COSTUME, baseAppearance({ prop: 'lute' }), ROLE_COLOR).costume.staff).toBe('lute');
  });
});

describe('resolveHeroCostume: accessory auto/none/explicit', () => {
  const BOTH: Costume = { cloak: 0x2c5238, goggles: true }; // e.g. the guild qa-engineer costume

  it('auto keeps whatever the theme gives, including both cloak and goggles at once', () => {
    const r = resolveHeroCostume(BOTH, baseAppearance({ accessory: 'auto' }), ROLE_COLOR);
    expect(r.costume.cloak).toBe(0x2c5238);
    expect(r.costume.goggles).toBe(true);
  });

  it('none omits both cloak and goggles', () => {
    const r = resolveHeroCostume(BOTH, baseAppearance({ accessory: 'none' }), ROLE_COLOR);
    expect(r.costume.cloak).toBeUndefined();
    expect(r.costume.goggles).toBeUndefined();
  });

  it('an explicit goggles accessory drops any theme cloak', () => {
    const r = resolveHeroCostume(BOTH, baseAppearance({ accessory: 'goggles' }), ROLE_COLOR);
    expect(r.costume.goggles).toBe(true);
    expect(r.costume.cloak).toBeUndefined();
  });

  it('accessoryColor: explicit > theme cloak colour > roleColor (not outfit)', () => {
    const explicit = resolveHeroCostume(BOTH, baseAppearance({ accessory: 'cloak', accessoryColor: '#00ff00' }), ROLE_COLOR);
    expect(explicit.costume.cloak).toBe(0x00ff00);

    const themed = resolveHeroCostume(BOTH, baseAppearance({ accessory: 'cloak', accessoryColor: null }), ROLE_COLOR);
    expect(themed.costume.cloak).toBe(0x2c5238);

    const roleFallback = resolveHeroCostume(MODERN_COSTUME, baseAppearance({ accessory: 'cloak', accessoryColor: null, outfitColor: '#123456' }), ROLE_COLOR);
    expect(roleFallback.costume.cloak).toBe(ROLE_COLOR);
    expect(roleFallback.costume.cloak).not.toBe(roleFallback.outfit); // proves the fallback is roleColor, not outfit
  });
});

describe('resolveHeroCostume: determinism', () => {
  it('is a pure function of its inputs (same appearance -> identical resolved costume)', () => {
    const a = baseAppearance({ hat: 'crown', prop: 'staff', accessory: 'cloak' });
    const r1 = resolveHeroCostume(GUILD_PM_COSTUME, a, ROLE_COLOR);
    const r2 = resolveHeroCostume(GUILD_PM_COSTUME, a, ROLE_COLOR);
    expect(r2).toEqual(r1);
  });

  it('resolves the same look every time for a given (project, role, slot) seed', () => {
    const seed = heroSeed('proj-1', 'developer', 0);
    const a1 = generateHeroAppearance(seed);
    const a2 = generateHeroAppearance(seed);
    expect(a2).toEqual(a1);
    const r1 = resolveHeroCostume(GUILD_DEVELOPER_COSTUME, a1, ROLE_COLOR);
    const r2 = resolveHeroCostume(GUILD_DEVELOPER_COSTUME, a2, ROLE_COLOR);
    expect(r2).toEqual(r1);
  });

  it('different slots seed different looks (not a hard requirement, but the generator should vary)', () => {
    const a0 = generateHeroAppearance(heroSeed('proj-1', 'developer', 0));
    const a1 = generateHeroAppearance(heroSeed('proj-1', 'developer', 1));
    expect(a0).not.toEqual(a1);
  });
});
