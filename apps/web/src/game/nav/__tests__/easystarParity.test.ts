import { describe, expect, it } from 'vitest';
import * as EasyStarNS from 'easystarjs';
import { DEFAULT_LAYOUT, hasLayoutErrors, type OfficeLayout } from '@tagconn/shared';
import { generateRandomLayout } from '../../procgen/bsp';
import { generateMap } from '../../procgen/generate';
import type { Point } from '../../procgen/types';
import { PathFinder } from '../adapter';
import { maxRoomsLayout, toLayout } from './perfLayout';

// M15 W2 (navigation.md section 4.7, property 8): the nav adapter must route like the easystar wrapper
// it replaces. The old wrapper is reconstructed here verbatim from
// `git show e65224e:apps/web/src/game/pathfinding.ts`; W3 deletes this file together with easystarjs.
//
// Parity means: identical reachability, identical ends, and a path that is never costlier than
// easystar's. "Equal cost" cannot hold on every pair: easystarjs 0.4.4's octile heuristic
// (`getDistance`: `1.4 * min(dx, dy) + max(dx, dy)` instead of `1.4 * min + (max - min)`) overestimates
// by `min(dx, dy)`, so easystar is not optimal and sometimes returns a longer path (e.g. the default
// hall's pm-office seat: 39.9 vs 38.1). The macro planner is checked against an exact reference in
// macro.test.ts; here the test counts the pairs where easystar is longer and asserts ours never is.

const EasyStar: typeof EasyStarNS = (EasyStarNS as unknown as { default?: typeof EasyStarNS }).default ?? EasyStarNS;

/** The pre-M15 `PathFinder` (thin synchronous wrapper around easystarjs). */
class LegacyPathFinder {
  private es = new EasyStar.js();
  private cols: number;
  private rows: number;

  constructor(private walkable: number[][]) {
    this.rows = walkable.length;
    this.cols = walkable[0]?.length ?? 0;
    this.es.setGrid(walkable);
    this.es.setAcceptableTiles([0]);
    this.es.enableDiagonals();
    this.es.disableCornerCutting();
    this.es.enableSync();
  }

  isWalkable(p: Point): boolean {
    return this.walkable[p.y]?.[p.x] === 0;
  }

  find(from: Point, to: Point): Point[] | null {
    const inside = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < this.cols && p.y < this.rows;
    if (!inside(from) || !inside(to) || !this.isWalkable(to)) return null;
    if (from.x === to.x && from.y === to.y) return [from];
    const startBlocked = !this.isWalkable(from);
    if (startBlocked) this.walkable[from.y]![from.x] = 0;
    let result: Point[] | null = null;
    this.es.setGrid(this.walkable);
    this.es.findPath(from.x, from.y, to.x, to.y, (path) => {
      result = path ? path.map((p) => ({ x: p.x, y: p.y })) : null;
    });
    this.es.calculate();
    if (startBlocked) {
      this.walkable[from.y]![from.x] = 1;
      this.es.setGrid(this.walkable);
    }
    return result;
  }
}

/** Octile cost of a tile path with the given diagonal weight (SQRT2 for the nav planner, 1.4 for easystar). */
function octileCost(path: readonly Point[], diagonal = Math.SQRT2): number {
  let cost = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = Math.abs(path[i]!.x - path[i - 1]!.x);
    const dy = Math.abs(path[i]!.y - path[i - 1]!.y);
    cost += dx === 1 && dy === 1 ? diagonal : 1;
  }
  return cost;
}

const EPS = 1e-6;

/** 300 `generateRandomLayout` seeds (both backgrounds, incl. 128 x 96), plus the classic hall and the perf layout. */
function parityLayouts(): OfficeLayout[] {
  const out: OfficeLayout[] = [DEFAULT_LAYOUT, toLayout(maxRoomsLayout(), 'perf')];
  for (let seed = 1; seed <= 145; seed++) {
    for (const background of ['hall', 'void'] as const) {
      out.push(toLayout(generateRandomLayout({ width: 48, height: 30, seed, background }), `bsp${seed}-${background}`));
    }
  }
  for (let seed = 1; seed <= 5; seed++) {
    for (const background of ['hall', 'void'] as const) {
      out.push(toLayout(generateRandomLayout({ width: 128, height: 96, seed: 1000 + seed, background }), `big${seed}-${background}`));
    }
  }
  return out;
}

describe('easystar parity (navigation.md section 5, property 8)', () => {
  it(
    'spawn -> every seat: same reachability, same ends, never a costlier path than easystar on 300 random layouts',
    () => {
      const layouts = parityLayouts();
      expect(layouts.length).toBe(302);
      let pairs = 0;
      let big = 0;
      let equal = 0;
      let shorter = 0;
      for (const layout of layouts) {
        const map = generateMap(layout);
        expect(hasLayoutErrors(map.issues), layout.id).toBe(false);
        if (map.cols === 128 && map.rows === 96) big++;
        const legacy = new LegacyPathFinder(map.walkable.map((row) => [...row]));
        const finder = new PathFinder(map.nav!);
        for (const room of map.rooms) {
          for (const seat of room.seats) {
            const expected = legacy.find(map.spawn, seat);
            const actual = finder.find(map.spawn, seat);
            const label = `${layout.id} ${room.id} seat ${seat.x},${seat.y}`;
            expect(actual === null, label).toBe(expected === null);
            if (expected !== null && actual !== null) {
              expect(actual[0], label).toEqual(expected[0]);
              expect(actual[actual.length - 1], label).toEqual(expected[expected.length - 1]);
              expect(actual.every((p) => finder.isWalkable(p)), label).toBe(true);
              // Never costlier, under the planner's weights and under easystar's own.
              const ours = octileCost(actual);
              const theirs = octileCost(expected);
              expect(ours, label).toBeLessThanOrEqual(theirs + EPS);
              expect(octileCost(actual, 1.4), label).toBeLessThanOrEqual(octileCost(expected, 1.4) + EPS);
              if (Math.abs(ours - theirs) < EPS) equal++;
              else shorter++;
            }
            pairs++;
          }
        }
      }
      expect(big).toBeGreaterThanOrEqual(11);
      expect(pairs).toBeGreaterThan(3000);
      // Measured on these seeds: ~61% of pairs tie exactly, easystar is longer on the rest (long paths
      // through several rooms, where its overestimate adds up). Guard the ratio so a regression that makes
      // the planner wander (still "never costlier" than easystar) is caught.
      expect(equal / (equal + shorter)).toBeGreaterThan(0.5);
      console.info(`easystar parity: ${pairs} pairs, ${equal} equal, ${shorter} where easystar was longer`);
    },
    120_000,
  );

  it('null and [from] cases agree', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const legacy = new LegacyPathFinder(map.walkable.map((row) => [...row]));
    const finder = new PathFinder(map.nav!);
    const blocked = { x: 0, y: 0 };
    expect(legacy.isWalkable(blocked)).toBe(false);
    for (const [from, to] of [
      [map.spawn, blocked],
      [blocked, blocked],
      [{ x: -1, y: 0 }, map.spawn],
      [map.spawn, { x: map.cols, y: 0 }],
    ] as const) {
      expect(finder.find(from, to)).toEqual(legacy.find(from, to));
    }
    expect(finder.find(map.spawn, map.spawn)).toEqual([map.spawn]);
    expect(legacy.find(map.spawn, map.spawn)).toEqual([map.spawn]);
    // Blocked start: both route out of it to the spawn.
    const desk = map.furniture.find((f) => f.kind === 'work-desk' && !finder.isWalkable({ x: Math.floor(f.x), y: Math.floor(f.y) }))!;
    expect(desk).toBeDefined();
    const start = { x: Math.floor(desk.x), y: Math.floor(desk.y) };
    const a = finder.find(start, map.spawn)!;
    const b = legacy.find(start, map.spawn)!;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a[0]).toEqual(start);
    expect(b[0]).toEqual(start);
    expect(octileCost(a)).toBeLessThanOrEqual(octileCost(b) + EPS);
  });
});
