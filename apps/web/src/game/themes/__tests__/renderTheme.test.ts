import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import { renderGeneratedMap, THEME_BASE_TEXTURE } from '../renderTheme';
import { makeFakeScene } from './testUtils';

describe('renderGeneratedMap', () => {
  it('renders the default layout with both themes without throwing, and returns the base texture key', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    expect(map.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    for (const theme of [modernTheme, guildTheme]) {
      const { scene } = makeFakeScene();
      const key = renderGeneratedMap(scene, map, theme);
      expect(key).toBe(THEME_BASE_TEXTURE);
    }
  });
});
