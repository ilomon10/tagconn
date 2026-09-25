import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import { makeFakeScene } from './testUtils';

const map = generateMap(DEFAULT_LAYOUT);

describe('ambientEffects gating (guild.animate)', () => {
  it('creates no tweens when ambient is false', () => {
    const { scene, tweenCount } = makeFakeScene();
    expect(() => guildTheme.animate(scene, map, { ambient: false })).not.toThrow();
    expect(tweenCount()).toBe(0);
  });

  it('creates tweens (torch flicker, portal swirl, ...) when ambient is true', () => {
    const { scene, tweenCount } = makeFakeScene();
    const objects = guildTheme.animate(scene, map, { ambient: true });
    expect(tweenCount()).toBeGreaterThan(0);
    expect(objects.length).toBeGreaterThan(0);
  });

  it('still places static decor (torch brackets, banners) when ambient is false', () => {
    const { scene, imageCount } = makeFakeScene();
    guildTheme.animate(scene, map, { ambient: false });
    expect(imageCount()).toBeGreaterThan(0);
  });
});

describe('modern.animate', () => {
  it('never creates a tween either way (static art only)', () => {
    for (const ambient of [false, true]) {
      const { scene, tweenCount } = makeFakeScene();
      expect(() => modernTheme.animate(scene, map, { ambient })).not.toThrow();
      expect(tweenCount()).toBe(0);
    }
  });
});
