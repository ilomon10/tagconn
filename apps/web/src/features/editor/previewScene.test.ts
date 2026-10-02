import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { generateMap } from '../../game/procgen';
import { PathFinder } from '../../game/pathfinding';
import { CLASS_K, navPointOfTile } from '../../game/nav';

// PreviewScene needs Phaser (no node import), so its pure piece lives in wander.ts:
// the wander target must be a walkable tile that the navigator can reach from the spawn.
async function load() {
  return import('./wander');
}

describe('pickWanderTile', () => {
  it('returns a walkable tile other than the origin, deterministic for a given rng', async () => {
    const { pickWanderTile } = await load();
    const map = generateMap(DEFAULT_LAYOUT);
    const a = pickWanderTile(map, map.spawn, () => 0.5)!;
    expect(map.walkable[a.y]?.[a.x]).toBe(0);
    expect(a).not.toEqual(map.spawn);
    expect(pickWanderTile(map, map.spawn, () => 0.5)).toEqual(a);
  });

  it('yields targets the navigator can path to from the spawn', async () => {
    const { pickWanderTile } = await load();
    const map = generateMap(DEFAULT_LAYOUT);
    const nav = new PathFinder(map.nav).navigator();
    let reached = 0;
    for (const r of [0.1, 0.4, 0.7, 0.95]) {
      const to = pickWanderTile(map, map.spawn, () => r)!;
      if (nav.findPath(navPointOfTile(map.spawn, CLASS_K.person), navPointOfTile(to, CLASS_K.person), 'person')) reached++;
    }
    expect(reached).toBeGreaterThan(0);
  });
});
