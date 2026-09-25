import { describe, expect, it } from 'vitest';
import { hasLayoutErrors, MULTIVERSE_LIMITS, validateLayout, type MultiverseProjectInput } from '@tagconn/shared';
import { generateMap } from '../../procgen';
import { planMultiverse, type PlanMultiverseOptions } from '../plan';

const NOW = 1_000_000_000;

function project(i: number, overrides: Partial<MultiverseProjectInput> = {}): MultiverseProjectInput {
  return {
    id: `p${i}`,
    name: `Project ${i}`,
    style: i % 2 === 0 ? 'guild' : 'modern',
    createdAt: i * 1000,
    lastActivityAt: NOW - i * 10,
    liveAgents: 1,
    lastLiveAt: NOW,
    ...overrides,
  };
}

const OPTS: PlanMultiverseOptions = { maxRealms: MULTIVERSE_LIMITS.maxRealms, floorOrder: 'created', now: NOW, idleLeaveSec: 300 };

/** Every seat in every realm room (and the Nexus) is reachable from spawn, with 0 generator errors. */
function assertFullyReachable(plan: ReturnType<typeof planMultiverse>): void {
  const issues = validateLayout(plan.layout);
  expect(hasLayoutErrors(issues)).toBe(false);
  const map = generateMap(plan.layout);
  expect(hasLayoutErrors(map.issues)).toBe(false);
  // generateMap silently falls back to DEFAULT_LAYOUT on a geometry error; guard against that too.
  expect(map.layoutId).toBe(plan.layout.id);
  for (const realm of plan.realms) {
    for (const roomId of realm.roomIds) {
      const room = map.rooms.find((r) => r.id === roomId);
      expect(room, `room ${roomId} missing from generated map`).toBeDefined();
      if (!room || room.type === 'stairs' || room.type === 'hall') continue;
      expect(room.tiles.length, `room ${roomId} has no reachable tile`).toBeGreaterThan(0);
      for (const seat of room.seats) {
        const reachable = room.tiles.some((t) => t.x === seat.x && t.y === seat.y);
        expect(reachable, `seat in ${roomId} at (${seat.x},${seat.y}) is unreachable`).toBe(true);
      }
    }
  }
}

describe('planMultiverse: 0..40 projects', () => {
  for (const n of [0, 1, 2, 3, 5, 8, 9, 12, 13, 20, 40]) {
    it(`produces a fully valid, reachable layout for ${n} projects`, () => {
      const projects = Array.from({ length: n }, (_, i) => project(i));
      const plan = planMultiverse(projects, OPTS);
      assertFullyReachable(plan);
    });
  }
});

describe('planMultiverse: realm selection and cap', () => {
  it('gives every project its own realm when within the cap', () => {
    const projects = Array.from({ length: 5 }, (_, i) => project(i));
    const plan = planMultiverse(projects, OPTS);
    expect(plan.realms).toHaveLength(5);
    expect(plan.realms.every((r) => !r.overflow)).toBe(true);
    for (const p of projects) expect(plan.realmByProject[p.id]).toBeDefined();
  });

  it('caps realms at office.multiverseMaxRealms and groups the rest into one overflow realm', () => {
    const maxRealms = 4;
    const projects = Array.from({ length: 10 }, (_, i) => project(i, { liveAgents: 10 - i }));
    const plan = planMultiverse(projects, { ...OPTS, maxRealms });
    // maxRealms - 1 dedicated realms + 1 overflow realm.
    expect(plan.realms).toHaveLength(maxRealms);
    const overflowRealm = plan.realms.find((r) => r.overflow);
    expect(overflowRealm).toBeDefined();
    expect(overflowRealm!.name).toContain('Other realms');
    expect(overflowRealm!.style).toBeNull();
    expect(overflowRealm!.projectIds).toHaveLength(10 - (maxRealms - 1));
    // The busiest projects (highest liveAgents) get their own realm.
    const dedicated = plan.realms.filter((r) => !r.overflow);
    expect(dedicated.every((r) => r.projectIds[0] !== undefined && Number(r.projectIds[0]!.slice(1)) < maxRealms - 1)).toBe(true);
    // Every project maps somewhere.
    for (const p of projects) expect(plan.realmByProject[p.id]).toBeDefined();
    assertFullyReachable(plan);
  });

  it('excludes projects with no live agent and no recent activity (hysteresis)', () => {
    const worthy = project(0, { liveAgents: 1 });
    const recentlyLive = project(1, { liveAgents: 0, lastLiveAt: NOW - 100 });
    const stale = project(2, { liveAgents: 0, lastLiveAt: NOW - 10 * 300_000 });
    const plan = planMultiverse([worthy, recentlyLive, stale], OPTS);
    expect(plan.realmByProject[worthy.id]).toBeDefined();
    expect(plan.realmByProject[recentlyLive.id]).toBeDefined();
    expect(plan.realmByProject[stale.id]).toBeUndefined();
    expect(plan.realms).toHaveLength(2);
  });

  it('switches from a 3x3 to a 4x4 grid past 8 realms', () => {
    const eight = planMultiverse(Array.from({ length: 8 }, (_, i) => project(i)), OPTS);
    expect(eight.layout.width).toBe(3 * MULTIVERSE_LIMITS.cellWidth);
    const nine = planMultiverse(Array.from({ length: 9 }, (_, i) => project(i)), OPTS);
    expect(nine.layout.width).toBe(4 * MULTIVERSE_LIMITS.cellWidth);
  });

  it('handles 0 projects (Nexus only)', () => {
    const plan = planMultiverse([], OPTS);
    expect(plan.realms).toHaveLength(0);
    assertFullyReachable(plan);
  });
});

describe('planMultiverse: stability under churn', () => {
  it('keeps the same key and realm cells when only activity fields change (created order)', () => {
    const projects = Array.from({ length: 6 }, (_, i) => project(i));
    const plan1 = planMultiverse(projects, OPTS);
    const churned = projects.map((p, i) => ({ ...p, liveAgents: p.liveAgents + i, lastActivityAt: p.lastActivityAt + 999 }));
    const plan2 = planMultiverse(churned, OPTS);
    expect(plan2.key).toBe(plan1.key);
    expect(plan2.layout).toEqual(plan1.layout);
    expect(plan2.realmByProject).toEqual(plan1.realmByProject);
  });

  it('assigns realms by project id order, not by activity, when floorOrder ties (same createdAt)', () => {
    const projects = [project(0, { id: 'zzz', createdAt: 0 }), project(1, { id: 'aaa', createdAt: 0 })];
    const shuffled = [projects[1]!, projects[0]!];
    const plan1 = planMultiverse(projects, OPTS);
    const plan2 = planMultiverse(shuffled, OPTS);
    expect(plan2.realmByProject).toEqual(plan1.realmByProject);
  });

  it('a realm reappearing after churn re-seats at the same cell (rebuild only on key change)', () => {
    const projects = Array.from({ length: 3 }, (_, i) => project(i));
    const plan1 = planMultiverse(projects, OPTS);
    const withoutMiddle = [projects[0]!, projects[2]!];
    const plan2 = planMultiverse(withoutMiddle, OPTS);
    expect(plan2.key).not.toBe(plan1.key);
    const plan3 = planMultiverse(projects, OPTS);
    expect(plan3.key).toBe(plan1.key);
    expect(plan3.layout).toEqual(plan1.layout);
  });
});

describe('planMultiverse: overflow realm banner text', () => {
  it('names the overflow realm with the leftover count', () => {
    const projects = Array.from({ length: 15 }, (_, i) => project(i));
    const plan = planMultiverse(projects, { ...OPTS, maxRealms: 12 });
    const overflowRealm = plan.realms.find((r) => r.overflow);
    expect(overflowRealm?.name).toBe('Other realms (4)');
  });
});
