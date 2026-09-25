import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, MULTIVERSE_LIMITS } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import { riftTheme } from '../rift';
import { makeFakeScene } from './testUtils';

const map = generateMap(DEFAULT_LAYOUT);

describe('ambientEffects gating (rift.animate)', () => {
  it('creates no tweens when ambient is false', () => {
    const { scene, tweenCount } = makeFakeScene();
    expect(() => riftTheme.animate(scene, map, { ambient: false })).not.toThrow();
    expect(tweenCount()).toBe(0);
  });

  it('creates tweens (lantern glow, portal shimmer, aurora, motes) when ambient is true', () => {
    const { scene, tweenCount } = makeFakeScene();
    const objects = riftTheme.animate(scene, map, { ambient: true });
    expect(tweenCount()).toBeGreaterThan(0);
    expect(objects.length).toBeGreaterThan(0);
  });

  it('still places static decor (lanterns, banners) when ambient is false', () => {
    const { scene, imageCount } = makeFakeScene();
    riftTheme.animate(scene, map, { ambient: false });
    expect(imageCount()).toBeGreaterThan(0);
  });

  it('creates no global motes/aurora when `motes` is false (the per-realm call)', () => {
    const { scene: withMotes, tweenCount: countA } = makeFakeScene();
    riftTheme.animate(withMotes, map, { ambient: true, motes: true });
    const { scene: withoutMotes, tweenCount: countB } = makeFakeScene();
    riftTheme.animate(withoutMotes, map, { ambient: true, motes: false });
    // Both still animate lanterns/portals, but only the `motes: true` call adds aurora/star tweens.
    expect(countA()).toBeGreaterThan(countB());
  });

  it('respects a tight ambient budget (fewer or equal created objects than an unbounded call)', () => {
    const { scene: tight } = makeFakeScene();
    const tightObjects = riftTheme.animate(tight, map, { ambient: true, motes: true, budget: 1 });
    const { scene: generous } = makeFakeScene();
    const generousObjects = riftTheme.animate(generous, map, { ambient: true, motes: true, budget: MULTIVERSE_LIMITS.maxAmbientObjects });
    expect(tightObjects.length).toBeLessThanOrEqual(generousObjects.length);
  });
});
