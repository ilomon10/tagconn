import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import { riftTheme } from '../rift';
import { makeFakeScene } from './testUtils';

const map = generateMap(DEFAULT_LAYOUT);

function images(theme: typeof guildTheme, ambient: boolean): number {
  const f = makeFakeScene();
  theme.animate(f.scene, map, { ambient });
  return f.imageCount();
}

describe('guild chandeliers (M16)', () => {
  it('adds at least one image per map light under ambient, none without', () => {
    expect(map.lights?.length ?? 0).toBeGreaterThan(0);
    expect(images(guildTheme, true) - images(guildTheme, false)).toBeGreaterThanOrEqual(map.lights!.length);
  });

  it('adds none when the map has no lights', () => {
    const bare = { ...map, lights: [] };
    const f = makeFakeScene();
    guildTheme.animate(f.scene, bare, { ambient: true });
    const g = makeFakeScene();
    guildTheme.animate(g.scene, map, { ambient: true });
    expect(g.imageCount() - f.imageCount()).toBe(map.lights!.length);
  });

  it('modern and rift draw no chandeliers', () => {
    expect(images(modernTheme, true)).toBe(images(modernTheme, false));
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const f = makeFakeScene();
    riftTheme.animate(f.scene, { ...map, lights: [] }, { ambient: true });
    const g = makeFakeScene();
    riftTheme.animate(g.scene, map, { ambient: true });
    vi.restoreAllMocks();
    expect(g.imageCount()).toBe(f.imageCount());
  });
});
