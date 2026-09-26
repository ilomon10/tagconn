import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import { renderGeneratedMap, THEME_BASE_TEXTURE, type ThemeRegion } from '../renderTheme';
import type { ThemeDefinition } from '../types';
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

  // M8 8p (docs/design/back-wall.md section 3.2) -----------------------------------------------

  it('draws in the order tiles -> back wall -> wall decor -> doors -> furniture', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const order: string[] = [];
    const theme: ThemeDefinition = {
      ...modernTheme,
      paintFloor: (g, kind, px, py, rand) => {
        order.push('tile');
        modernTheme.paintFloor(g, kind, px, py, rand);
      },
      paintWall: (g, px, py, faceVisible, rand) => {
        order.push('tile');
        modernTheme.paintWall(g, px, py, faceVisible, rand);
      },
      paintVoid: (g, px, py, rand) => {
        order.push('tile');
        modernTheme.paintVoid(g, px, py, rand);
      },
      paintBackWall: (g, px, py, ctx, rand) => {
        order.push('backWall');
        modernTheme.paintBackWall!(g, px, py, ctx, rand);
      },
      paintWallDecor: (g, slot, T, face) => {
        order.push('wallDecor');
        modernTheme.paintWallDecor!(g, slot, T, face);
      },
      paintDoor: (g, kind, px, py, wide, rand) => {
        order.push('door');
        modernTheme.paintDoor(g, kind, px, py, wide, rand);
      },
      paintFurniture: (g, f, T) => {
        order.push('furniture');
        modernTheme.paintFurniture(g, f, T);
      },
    };
    const { scene } = makeFakeScene();
    renderGeneratedMap(scene, map, theme);

    // Sanity: every pass actually ran (DEFAULT_LAYOUT has north-wall decor, doors and furniture).
    for (const pass of ['tile', 'backWall', 'wallDecor', 'door', 'furniture']) expect(order).toContain(pass);
    const lastTile = order.lastIndexOf('tile');
    const firstBackWall = order.indexOf('backWall');
    const lastBackWall = order.lastIndexOf('backWall');
    const firstWallDecor = order.indexOf('wallDecor');
    const lastWallDecor = order.lastIndexOf('wallDecor');
    const firstDoor = order.indexOf('door');
    const lastDoor = order.lastIndexOf('door');
    const firstFurniture = order.indexOf('furniture');
    expect(lastTile).toBeLessThan(firstBackWall);
    expect(lastBackWall).toBeLessThan(firstWallDecor);
    expect(lastWallDecor).toBeLessThan(firstDoor);
    expect(lastDoor).toBeLessThan(firstFurniture);
  });

  it('never bands a back-wall face over a door tile (a north door reads as a gap)', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const calls: { x: number; y: number; band: boolean }[] = [];
    const theme: ThemeDefinition = {
      ...modernTheme,
      paintBackWall: (g, px, py, ctx, rand) => {
        calls.push({ x: px / map.tileSize, y: py / map.tileSize, band: ctx.band });
        modernTheme.paintBackWall!(g, px, py, ctx, rand);
      },
    };
    const { scene } = makeFakeScene();
    renderGeneratedMap(scene, map, theme);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      const below = map.tiles[c.y + 1]?.[c.x];
      expect(c.band).toBe(below === 'floor');
      if (!c.band) expect(below).toBe('door');
    }
  });

  it('generates the texture exactly once', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const { scene } = makeFakeScene();
    const generateTexture = vi.fn();
    const originalGraphics = scene.make.graphics;
    scene.make.graphics = ((...args: Parameters<typeof originalGraphics>) => {
      const g = originalGraphics(...args);
      const original = g.generateTexture.bind(g);
      g.generateTexture = ((...a: Parameters<typeof original>) => {
        generateTexture();
        return original(...a);
      }) as typeof g.generateTexture;
      return g;
    }) as typeof originalGraphics;
    renderGeneratedMap(scene, map, modernTheme);
    expect(generateTexture).toHaveBeenCalledTimes(1);
  });

  it('a theme without the optional back-wall hooks renders exactly as before (plain short face)', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const { backWall: _backWall, paintBackWall: _paintBackWall, paintWallDecor: _paintWallDecor, ...rest } = modernTheme;
    const plainTheme: ThemeDefinition = { ...rest };
    const faceVisibleCalls: boolean[] = [];
    const wrapped: ThemeDefinition = {
      ...plainTheme,
      paintWall: (g, px, py, faceVisible, rand) => {
        faceVisibleCalls.push(faceVisible);
        plainTheme.paintWall(g, px, py, faceVisible, rand);
      },
    };
    const { scene } = makeFakeScene();
    expect(() => renderGeneratedMap(scene, map, wrapped)).not.toThrow();
    // The old faceVisible-driven short face still runs: at least one wall tile is painted with its
    // face visible (a room with floor immediately south), matching pre-8p behaviour exactly.
    expect(faceVisibleCalls.some((v) => v)).toBe(true);
  });

  it('a Multiverse region paints its own back-wall face and wall decor, not the base theme', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const backWallCalls: { theme: string; x: number; y: number }[] = [];
    const wallDecorCalls: { theme: string; x: number; y: number }[] = [];
    function spy(name: string, theme: ThemeDefinition): ThemeDefinition {
      return {
        ...theme,
        paintBackWall: theme.paintBackWall
          ? (g, px, py, ctx, rand) => {
              backWallCalls.push({ theme: name, x: px / map.tileSize, y: py / map.tileSize });
              theme.paintBackWall!(g, px, py, ctx, rand);
            }
          : undefined,
        paintWallDecor: theme.paintWallDecor
          ? (g, slot, T, face) => {
              wallDecorCalls.push({ theme: name, x: slot.x, y: slot.y });
              theme.paintWallDecor!(g, slot, T, face);
            }
          : undefined,
      };
    }
    const guildSpy = spy('guild', guildTheme);
    const modernSpy = spy('modern', modernTheme);
    // A region covering the left half of the map (guild), the rest stays the base (modern) theme.
    const region: ThemeRegion = { rect: { x: 0, y: 0, w: Math.floor(map.cols / 2), h: map.rows }, theme: guildSpy };
    const { scene } = makeFakeScene();
    renderGeneratedMap(scene, map, modernSpy, [region]);

    expect(backWallCalls.length).toBeGreaterThan(0);
    expect(wallDecorCalls.length).toBeGreaterThan(0);
    for (const c of backWallCalls) expect(c.theme).toBe(c.x < region.rect.w ? 'guild' : 'modern');
    for (const c of wallDecorCalls) expect(c.theme).toBe(c.x < region.rect.w ? 'guild' : 'modern');
    // Both themes actually painted something (the region split isn't degenerate).
    expect(backWallCalls.some((c) => c.theme === 'guild')).toBe(true);
    expect(backWallCalls.some((c) => c.theme === 'modern')).toBe(true);
  });
});
