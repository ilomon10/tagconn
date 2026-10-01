import type { Agent } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import type { FurnitureKind, PlacedFurniture } from '../../procgen/types';
import type { LifeActivity } from '../../themes/types';
import { EMPTY_LIFE, KickoffTracker, lifeFor, nextLifeDelayMs, pickActivity, pickProp, pickStraggler, pickVenue, standupDue } from '../rules';

const T0 = 1_000_000;
function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id, sessionId: 's1', projectId: 'p', isMain: false, agentType: 'x', role: 'x', status: 'active', activity: 'idle',
    zone: 'desks', toolCount: 0, startedAt: T0, updatedAt: T0, ...over,
  } as Agent;
}
const main = (activity: Agent['activity'], over: Partial<Agent> = {}) => agent('main:s1', { isMain: true, activity, ...over });

describe('KickoffTracker', () => {
  it('opens on delegating, counts spawns in the window and fires once', () => {
    const t = new KickoffTracker();
    expect(t.observe([main('thinking')], T0, 30)).toEqual([]);
    expect(t.observe([main('delegating')], T0 + 1000, 30)).toEqual([]);
    const a = agent('a', { startedAt: T0 + 2000 });
    expect(t.observe([main('delegating'), a], T0 + 2000, 30)).toEqual([]); // only 1
    const b = agent('b', { startedAt: T0 + 3000 });
    const out = t.observe([main('delegating'), a, b], T0 + 3000, 30);
    expect(out).toEqual([{ sessionId: 's1', hostAgentId: 'main:s1', inviteeAgentIds: ['a', 'b'], at: T0 + 1000 }]);
    expect(t.observe([main('delegating'), a, b], T0 + 4000, 30)).toEqual([]);
  });
  it('counts a spawn up to 2 s before the window and ignores later ones, other sessions and expired windows', () => {
    const t = new KickoffTracker();
    t.observe([main('delegating')], T0, 30);
    const early = agent('e', { startedAt: T0 - 1500 });
    const old = agent('o', { startedAt: T0 - 5000 });
    const other = agent('x', { sessionId: 's2', startedAt: T0 + 100 });
    expect(t.observe([main('delegating'), early, old, other], T0 + 500, 30)).toEqual([]);
    const late = agent('l', { startedAt: T0 + 31_000 });
    expect(t.observe([main('delegating'), early, late], T0 + 31_500, 30)).toEqual([]); // expired
  });
  it('reopens only after the host stopped delegating, and clear() resets', () => {
    const t = new KickoffTracker();
    const kids = [agent('a', { startedAt: T0 }), agent('b', { startedAt: T0 })];
    expect(t.observe([main('delegating'), ...kids], T0, 30)).toHaveLength(1);
    expect(t.observe([main('delegating'), ...kids], T0 + 40_000, 30)).toEqual([]);
    t.observe([main('thinking'), ...kids], T0 + 41_000, 30);
    const c = [agent('c', { startedAt: T0 + 42_000 }), agent('d', { startedAt: T0 + 42_500 })];
    expect(t.observe([main('delegating'), ...c], T0 + 43_000, 30)).toHaveLength(1);
    t.clear();
    expect(t.observe([main('delegating'), ...c], T0 + 44_000, 30)).toHaveLength(1);
  });
});

describe('standupDue', () => {
  it('needs both the interval and the cast', () => {
    expect(standupDue(0, 59_999, 60, 3, 3)).toBe(false);
    expect(standupDue(0, 60_000, 60, 3, 3)).toBe(true);
    expect(standupDue(0, 60_000, 60, 2, 3)).toBe(false);
  });
});

const fur = (kind: FurnitureKind, roomId: string, x: number, y: number, w = 1, h = 1): PlacedFurniture =>
  ({ kind, roomId, x, y, w, h, blocking: true, roomType: 'desks', variant: 0 }) as PlacedFurniture;
const room = (id: string, type: string, x = 0, y = 0) => ({ id, type, interior: { x, y, w: 4, h: 4 } });

describe('pickVenue', () => {
  const rooms = [room('m1', 'meeting-room', 0, 0), room('m2', 'meeting-room', 20, 0), room('d', 'desks', 10, 0), room('l', 'lounge', 30, 0)] as never;
  it('prefers the meeting room with the largest table', () => {
    const furniture = [fur('table', 'm1', 1, 1, 2, 2), fur('table', 'm2', 21, 1, 3, 2), fur('reading-table', 'd', 11, 1, 5, 5)];
    expect(pickVenue({ rooms, furniture }, null, { x: 0, y: 0 })?.roomId).toBe('m2');
  });
  it('ties by distance to near, then room id', () => {
    const furniture = [fur('table', 'm1', 1, 1, 2, 2), fur('table', 'm2', 21, 1, 2, 2)];
    expect(pickVenue({ rooms, furniture }, null, { x: 25, y: 0 })?.roomId).toBe('m2');
    const same = [fur('table', 'm2', 1, 1, 2, 2), fur('table', 'm1', 1, 1, 2, 2)];
    expect(pickVenue({ rooms, furniture: same }, null, { x: 1, y: 1 })?.roomId).toBe('m1');
  });
  it('falls back to a table anywhere, then the lounge, then null; realm filter applies', () => {
    const anywhere = [fur('board-game-table', 'd', 11, 1, 2, 1)];
    expect(pickVenue({ rooms, furniture: anywhere }, null, { x: 0, y: 0 })).toMatchObject({ roomId: 'd' });
    expect(pickVenue({ rooms, furniture: [] }, null, { x: 0, y: 0 })).toEqual({ roomId: 'l', table: null });
    expect(pickVenue({ rooms, furniture: anywhere }, new Set(['l']), { x: 0, y: 0 })).toEqual({ roomId: 'l', table: null });
    expect(pickVenue({ rooms, furniture: [] }, new Set(['d']), { x: 0, y: 0 })).toBeNull();
    const both = [fur('table', 'm1', 1, 1, 2, 2), fur('table', 'm2', 21, 1, 3, 3)];
    expect(pickVenue({ rooms, furniture: both }, new Set(['m1']), { x: 0, y: 0 })?.roomId).toBe('m1');
  });
});

describe('pickStraggler', () => {
  it('is null below 2, deterministic and order independent', () => {
    expect(pickStraggler(['a'], 's')).toBeNull();
    expect(pickStraggler([], 's')).toBeNull();
    const a = pickStraggler(['a', 'b', 'c'], 'seed');
    expect(a).toBe(pickStraggler(['c', 'a', 'b'], 'seed'));
    expect(['a', 'b', 'c']).toContain(a);
  });
});

const act = (id: string, over: Partial<LifeActivity> = {}): LifeActivity => ({
  id, requires: [], cast: [1, 2], weight: 1, durationSec: [5, 10], pose: 'sit', lines: [], ...over,
}) as LifeActivity;

describe('pickActivity', () => {
  const avail = new Set<FurnitureKind>(['arcade']);
  it('filters by requires and cast', () => {
    const list = [act('free'), act('arc', { requires: ['arcade', 'foosball'] }), act('pong', { requires: ['ping-pong'] }), act('big', { cast: [3, 4] })];
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(pickActivity(list, avail, 2, `s${i}`)!.id);
    expect([...seen].sort()).toEqual(['arc', 'free']);
    expect(pickActivity([act('pong', { requires: ['ping-pong'] })], avail, 2, 's')).toBeNull();
    expect(pickActivity([], avail, 2, 's')).toBeNull();
  });
  it('is weighted (seeded histogram) and order independent', () => {
    const list = [act('a', { weight: 9 }), act('b', { weight: 1 })];
    const n = { a: 0, b: 0 };
    for (let i = 0; i < 1000; i++) n[pickActivity(list, avail, 2, `seed${i}`)!.id as 'a' | 'b']++;
    expect(n.a).toBeGreaterThan(800);
    expect(n.b).toBeGreaterThan(40);
    for (let i = 0; i < 20; i++) expect(pickActivity(list, avail, 2, `k${i}`)?.id).toBe(pickActivity([...list].reverse(), avail, 2, `k${i}`)?.id);
  });
});

describe('pickProp', () => {
  const furniture = [fur('arcade', 'r1', 1, 1), fur('arcade', 'r1', 6, 6), fur('arcade', 'r2', 3, 3), fur('sofa', 'r1', 2, 2)];
  it('picks the nearest of the kinds, skipping taken and filtered rooms', () => {
    expect(pickProp(furniture, ['arcade'], { x: 0, y: 0 }, null, new Set())).toMatchObject({ x: 1, y: 1 });
    expect(pickProp(furniture, ['arcade'], { x: 0, y: 0 }, null, new Set(['1,1']))).toMatchObject({ x: 3, y: 3 });
    expect(pickProp(furniture, ['arcade'], { x: 0, y: 0 }, new Set(['r1']), new Set(['1,1']))).toMatchObject({ x: 6, y: 6 });
    expect(pickProp(furniture, ['foosball'], { x: 0, y: 0 }, null, new Set())).toBeNull();
  });
});

describe('nextLifeDelayMs / lifeFor', () => {
  it('stays within 0.5..1.5 of the average and is deterministic', () => {
    for (let b = 0; b < 50; b++) {
      const d = nextLifeDelayMs('f', b, 60);
      expect(d).toBeGreaterThanOrEqual(30_000);
      expect(d).toBeLessThan(90_000);
    }
    expect(nextLifeDelayMs('f', 3, 60)).toBe(nextLifeDelayMs('f', 3, 60));
  });
  it('lifeFor falls back to EMPTY_LIFE', () => {
    expect(lifeFor({})).toBe(EMPTY_LIFE);
    const life = { ...EMPTY_LIFE };
    expect(lifeFor({ life })).toBe(life);
  });
});
