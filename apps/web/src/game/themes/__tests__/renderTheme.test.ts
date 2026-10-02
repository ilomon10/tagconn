import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT, MULTIVERSE_LIMITS, type MultiverseProjectInput } from '@tagconn/shared';
import { planMultiverse } from '../../multiverse/plan';
import { generateMap } from '../../procgen';
import { quadrantTile, type DualCell, type Quadrant } from '../dual/dualGrid';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import { renderGeneratedMap, THEME_BASE_TEXTURE, type ThemeRegion } from '../renderTheme';
import { riftTheme } from '../rift';
import type { ThemeDefinition } from '../types';
import { makeFakeScene, type RecordedRect } from './testUtils';

/** A copy of `theme` without the M15 dual hooks: renders the pre-M15 flat command stream whatever the flag. */
function withoutDualHooks(theme: ThemeDefinition): ThemeDefinition {
  const { paintWallBase: _base, paintDualFloor: _floor, paintDualWall: _wall, ...rest } = theme;
  return { ...rest };
}

function rectContains(r: ThemeRegion['rect'], x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

function countTiles(map: ReturnType<typeof generateMap>, kind: string): number {
  return map.tiles.flat().filter((t) => t === kind).length;
}

/** A two-realm Multiverse map (void margins around every realm) with its regions, as `OfficeScene` builds them. */
function multiverseFixture() {
  const projects: MultiverseProjectInput[] = [
    { id: 'guild-proj', name: 'Guild Project', style: 'guild', createdAt: 0, lastActivityAt: 0, liveAgents: 1, lastLiveAt: 0 },
    { id: 'modern-proj', name: 'Modern Project', style: 'modern', createdAt: 1000, lastActivityAt: 0, liveAgents: 1, lastLiveAt: 0 },
  ];
  const plan = planMultiverse(projects, { maxRealms: MULTIVERSE_LIMITS.maxRealms, floorOrder: 'created', now: 0, idleLeaveSec: 300 });
  const map = generateMap(plan.layout);
  expect(map.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  const rects = plan.realms.filter((r) => !r.overflow).map((r) => r.cell);
  expect(rects.length).toBe(2);
  return { map, rects };
}

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

  // M15 dual grid (docs/design/dual-grid.md section 4.5) -----------------------------------------

  it('dual pass: each hook runs exactly (cols+1)(rows+1) times, floor before wall per cell, after the last tile and before the first back-wall call', () => {
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
      paintWallBase: (g, px, py, rand) => {
        order.push('tile');
        modernTheme.paintWallBase!(g, px, py, rand);
      },
      paintVoid: (g, px, py, rand) => {
        order.push('tile');
        modernTheme.paintVoid(g, px, py, rand);
      },
      paintDualFloor: (g, ctx, rand) => {
        order.push('dualFloor');
        modernTheme.paintDualFloor!(g, ctx, rand);
      },
      paintDualWall: (g, ctx, rand) => {
        order.push('dualWall');
        modernTheme.paintDualWall!(g, ctx, rand);
      },
      paintBackWall: (g, px, py, ctx, rand) => {
        order.push('backWall');
        modernTheme.paintBackWall!(g, px, py, ctx, rand);
      },
    };
    const { scene } = makeFakeScene();
    renderGeneratedMap(scene, map, theme, [], { dualGrid: true });

    const cells = (map.cols + 1) * (map.rows + 1);
    expect(order.filter((o) => o === 'dualFloor')).toHaveLength(cells);
    expect(order.filter((o) => o === 'dualWall')).toHaveLength(cells);
    const lastTile = order.lastIndexOf('tile');
    const firstBackWall = order.indexOf('backWall');
    const firstDual = order.findIndex((o) => o.startsWith('dual'));
    const lastDual = order.length - 1 - [...order].reverse().findIndex((o) => o.startsWith('dual'));
    expect(firstBackWall).toBeGreaterThan(-1);
    expect(lastTile).toBeLessThan(firstDual);
    expect(lastDual).toBeLessThan(firstBackWall);
    // Floor edges first, then the wall outline, for every cell (a floor peninsula next to a cap).
    const dualOnly = order.filter((o) => o.startsWith('dual'));
    for (let i = 0; i < dualOnly.length; i += 2) {
      expect(dualOnly[i]).toBe('dualFloor');
      expect(dualOnly[i + 1]).toBe('dualWall');
    }
  });

  it('dual pass is on by default: `renderGeneratedMap(scene, map, theme)` calls the hooks', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const paintDualWall = vi.fn(modernTheme.paintDualWall!);
    const { scene } = makeFakeScene();
    renderGeneratedMap(scene, map, { ...modernTheme, paintDualWall });
    expect(paintDualWall).toHaveBeenCalledTimes((map.cols + 1) * (map.rows + 1));
  });

  it('off path: `{ dualGrid: false }` calls no dual hook and records the identical command stream to a theme without the hooks', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const render = (theme: ThemeDefinition, dualGrid: boolean): { rects: RecordedRect[]; calls: string[] } => {
      const fake = makeFakeScene({ recordRects: true });
      renderGeneratedMap(fake.scene, map, theme, [], { dualGrid });
      return { rects: fake.rects, calls: fake.calls };
    };
    for (const base of [modernTheme, guildTheme]) {
      const stripped = withoutDualHooks(base);
      const flatOn = render(stripped, true);
      const flatOff = render(stripped, false);
      // A theme without hooks is unaffected by the flag.
      expect(flatOn.rects).toEqual(flatOff.rects);
      expect(flatOn.calls).toEqual(flatOff.calls);
      expect(flatOff.rects.length).toBeGreaterThan(0);

      const paintWallBase = vi.fn(base.paintWallBase!);
      const paintDualFloor = vi.fn(base.paintDualFloor!);
      const paintDualWall = vi.fn(base.paintDualWall!);
      const paintWall = vi.fn(base.paintWall);
      const hooked: ThemeDefinition = { ...base, paintWall, paintWallBase, paintDualFloor, paintDualWall };
      const off = render(hooked, false);
      expect(paintDualFloor).not.toHaveBeenCalled();
      expect(paintDualWall).not.toHaveBeenCalled();
      expect(paintWallBase).not.toHaveBeenCalled();
      expect(paintWall).toHaveBeenCalledTimes(countTiles(map, 'wall'));
      // Byte-identical to the flat stream: same rects, same draw calls, same order.
      expect(off.rects).toEqual(flatOff.rects);
      expect(off.calls).toEqual(flatOff.calls);

      // And the pass actually adds something when on (not a vacuous comparison).
      const on = render(hooked, true);
      expect(on.rects.length).toBeGreaterThan(flatOff.rects.length);
    }
  });

  it('dual on: `paintWallBase` replaces `paintWall` for every wall tile when the theme has a tall face', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const paintWallBase = vi.fn(modernTheme.paintWallBase!);
    const paintWall = vi.fn(modernTheme.paintWall);
    const { scene } = makeFakeScene();
    renderGeneratedMap(scene, map, { ...modernTheme, paintWall, paintWallBase }, [], { dualGrid: true });
    expect(paintWallBase).toHaveBeenCalledTimes(countTiles(map, 'wall'));
    expect(paintWall).not.toHaveBeenCalled();
  });

  it('dual on: a theme with `paintWallBase` but no `paintBackWall` keeps `paintWall(faceVisible = true)` on its face tiles', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const { backWall: _backWall, paintBackWall: _paintBackWall, ...noFace } = modernTheme;
    const paintWallBase = vi.fn(noFace.paintWallBase!);
    const faceVisibleCalls: boolean[] = [];
    const paintWall = vi.fn<ThemeDefinition['paintWall']>((g, px, py, faceVisible, rand) => {
      faceVisibleCalls.push(faceVisible);
      noFace.paintWall(g, px, py, faceVisible, rand);
    });
    const { scene } = makeFakeScene();
    renderGeneratedMap(scene, map, { ...noFace, paintWall, paintWallBase }, [], { dualGrid: true });
    const faceTiles = map.tiles.flatMap((row, y) => row.filter((t, x) => t === 'wall' && ['floor', 'door'].includes(map.tiles[y + 1]?.[x] ?? ''))).length;
    expect(faceTiles).toBeGreaterThan(0);
    expect(faceVisibleCalls).toHaveLength(faceTiles);
    expect(faceVisibleCalls.every((v) => v)).toBe(true);
    expect(paintWallBase.mock.calls.length + paintWall.mock.calls.length).toBe(countTiles(map, 'wall'));
  });

  it('Multiverse: a dual cell is painted by the theme of its first non-void quadrant (br, bl, tr, tl); all-void cells by the base theme', () => {
    const { map, rects } = multiverseFixture();
    const calls: { theme: string; cell: DualCell }[] = [];
    function spy(name: string, theme: ThemeDefinition): ThemeDefinition {
      return {
        ...theme,
        paintDualWall: (g, ctx, rand) => {
          calls.push({ theme: name, cell: ctx.cell });
          theme.paintDualWall!(g, ctx, rand);
        },
      };
    }
    const regions: ThemeRegion[] = [
      { rect: rects[0]!, theme: spy('guild', guildTheme) },
      { rect: rects[1]!, theme: spy('modern', modernTheme) },
    ];
    const { scene } = makeFakeScene();
    renderGeneratedMap(scene, map, spy('rift', riftTheme), regions, { dualGrid: true });
    expect(calls).toHaveLength((map.cols + 1) * (map.rows + 1));

    const order: readonly Quadrant[] = ['br', 'bl', 'tr', 'tl'];
    const seen = new Set<string>();
    for (const { theme, cell } of calls) {
      const q = order.find((qq) => cell.kinds[qq] !== 'void');
      let expected = 'rift';
      if (q) {
        const t = quadrantTile(cell, q);
        expected = rects[0] && rectContains(rects[0], t.x, t.y) ? 'guild' : rects[1] && rectContains(rects[1], t.x, t.y) ? 'modern' : 'rift';
      } else {
        seen.add('all-void');
      }
      seen.add(expected);
      expect(theme).toBe(expected);
    }
    // The split is not degenerate: every theme painted cells, and all-void cells exist (the void margin).
    for (const s of ['guild', 'modern', 'rift', 'all-void']) expect(seen.has(s)).toBe(true);
  });

  it('Multiverse: every dual rect in the island-edge rows is recorded after the island-edge rects of that tile', () => {
    const { map, rects: realmRects } = multiverseFixture();
    const fake = makeFakeScene({ recordRects: true });
    // Index ranges into `fake.rects` per island-edge tile, and the index at which the dual pass starts.
    const edges: { x: number; y: number; from: number; to: number }[] = [];
    let dualFrom = -1;
    const base: ThemeDefinition = {
      ...riftTheme,
      paintIslandEdge: (g, px, py, depth, rand) => {
        const from = fake.rects.length;
        riftTheme.paintIslandEdge!(g, px, py, depth, rand);
        edges.push({ x: px / map.tileSize, y: py / map.tileSize, from, to: fake.rects.length });
      },
      paintDualFloor: (g, ctx, rand) => {
        if (dualFrom < 0) dualFrom = fake.rects.length;
        riftTheme.paintDualFloor!(g, ctx, rand);
      },
    };
    const regions: ThemeRegion[] = [
      { rect: realmRects[0]!, theme: guildTheme },
      { rect: realmRects[1]!, theme: modernTheme },
    ];
    renderGeneratedMap(fake.scene, map, base, regions, { dualGrid: true });
    expect(edges.length).toBeGreaterThan(0);
    expect(dualFrom).toBeGreaterThan(-1);
    // Island edges (pass 2) all land before the dual pass (2b) starts.
    for (const e of edges) expect(e.to).toBeLessThanOrEqual(dualFrom);
    // ...and the dual pass really draws into island-edge tiles (the rim on the void side of the realm's bottom wall).
    const T = map.tileSize;
    const overlaps = (r: RecordedRect, e: { x: number; y: number }) =>
      r.x < (e.x + 1) * T && r.x + r.w > e.x * T && r.y < (e.y + 1) * T && r.y + r.h > e.y * T;
    const dualRects = fake.rects.slice(dualFrom);
    expect(edges.some((e) => dualRects.some((r) => overlaps(r, e)))).toBe(true);
  });

  it('source guard: no dual painter calls `tileOf(` (a cell origin is half a tile off the grid)', () => {
    const dir = join(__dirname, '..', 'paint', 'dual');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8')).not.toContain('tileOf(');
  });
});
