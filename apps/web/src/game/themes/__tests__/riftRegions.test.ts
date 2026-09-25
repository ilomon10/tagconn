import { describe, expect, it, vi } from 'vitest';
import { MULTIVERSE_LIMITS, type MultiverseProjectInput } from '@tagconn/shared';
import { planMultiverse } from '../../multiverse/plan';
import { generateMap } from '../../procgen';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import { riftTheme } from '../rift';
import { renderGeneratedMap, THEME_BASE_TEXTURE, type ThemeRegion } from '../renderTheme';
import { makeFakeScene } from './testUtils';

/** Wraps every paint method of a theme with a spy that records the tile it was called for, so a
 *  test can assert which theme painted which region without touching a real canvas. */
function spyOn(theme: typeof guildTheme) {
  const floorCalls: { x: number; y: number }[] = [];
  const furnitureCalls: { x: number; y: number }[] = [];
  const spied = {
    ...theme,
    paintFloor: vi.fn((g, kind, px, py, rand) => {
      floorCalls.push({ x: px / 16, y: py / 16 });
      return theme.paintFloor(g, kind, px, py, rand);
    }),
    paintFurniture: vi.fn((g, f, T) => {
      furnitureCalls.push({ x: f.x, y: f.y });
      return theme.paintFurniture(g, f, T);
    }),
  };
  return { spied, floorCalls, furnitureCalls };
}

function rectContains(r: ThemeRegion['rect'], x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

describe('renderGeneratedMap: per-region theme override (the Multiverse, M8 8h)', () => {
  it('paints a realm with its own project style and everything else with rift', () => {
    const projects: MultiverseProjectInput[] = [
      { id: 'guild-proj', name: 'Guild Project', style: 'guild', createdAt: 0, lastActivityAt: 0, liveAgents: 1, lastLiveAt: 0 },
      { id: 'modern-proj', name: 'Modern Project', style: 'modern', createdAt: 1000, lastActivityAt: 0, liveAgents: 1, lastLiveAt: 0 },
    ];
    const plan = planMultiverse(projects, { maxRealms: MULTIVERSE_LIMITS.maxRealms, floorOrder: 'created', now: 0, idleLeaveSec: 300 });
    const map = generateMap(plan.layout);
    expect(map.issues.filter((i) => i.severity === 'error')).toHaveLength(0);

    const guildSpy = spyOn(guildTheme);
    const modernSpy = spyOn(modernTheme);
    const regions: ThemeRegion[] = plan.realms
      .filter((r) => !r.overflow)
      .map((r, i) => ({ rect: r.cell, theme: (i === 0 ? guildSpy.spied : modernSpy.spied) as typeof guildTheme }));

    const { scene } = makeFakeScene();
    const key = renderGeneratedMap(scene, map, riftTheme, regions);
    expect(key).toBe(THEME_BASE_TEXTURE);

    // Every tile the guild spy painted lies inside its realm's cell, and never inside the other
    // project's cell (regions never bleed into each other).
    const guildRegion = regions[0]!.rect;
    const modernRegion = regions[1]!.rect;
    expect(guildSpy.floorCalls.length).toBeGreaterThan(0);
    expect(modernSpy.floorCalls.length).toBeGreaterThan(0);
    for (const c of guildSpy.floorCalls) {
      expect(rectContains(guildRegion, c.x, c.y)).toBe(true);
      expect(rectContains(modernRegion, c.x, c.y)).toBe(false);
    }
    for (const c of modernSpy.floorCalls) {
      expect(rectContains(modernRegion, c.x, c.y)).toBe(true);
      expect(rectContains(guildRegion, c.x, c.y)).toBe(false);
    }
    // Furniture inside each realm's rooms is painted by that realm's theme too.
    expect(guildSpy.furnitureCalls.length).toBeGreaterThan(0);
    expect(modernSpy.furnitureCalls.length).toBeGreaterThan(0);
  });

  it('falls back to the base theme when no regions are given (existing single-theme callers)', () => {
    const projects: MultiverseProjectInput[] = [];
    const plan = planMultiverse(projects, { maxRealms: MULTIVERSE_LIMITS.maxRealms, floorOrder: 'created', now: 0, idleLeaveSec: 300 });
    const map = generateMap(plan.layout);
    const { scene } = makeFakeScene();
    expect(() => renderGeneratedMap(scene, map, riftTheme)).not.toThrow();
  });
});
