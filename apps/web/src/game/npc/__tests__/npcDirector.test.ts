import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NpcDirector } from '../npcDirector';
import type { NpcActor, NpcHost, NpcScriptCtx, ReactionController } from '../types';

class FakeChar {
  leaving = false;
  gone = false;
  updates = 0;
  dim = 1;
  destroyed = false;
  look: unknown;
  creature: unknown = 'unset';
  costume: unknown;
  activity: unknown;
  plate: unknown;
  constructor(public key: string, public at: { x: number; y: number }) {}
  update() { this.updates++; }
  setDim(a: number) { this.dim = a; }
  setLook(l: unknown) { this.look = l; }
  setCostume(c: unknown) { this.costume = c; }
  setCreature(c: unknown) { this.creature = c; }
  setActivity(...a: unknown[]) { this.activity = a; }
  setPlateOptions(p: unknown) { this.plate = p; }
  sayDrama() {}
  destroyAll() { this.destroyed = true; }
}

const NPCS = { enabled: true, janitor: true, encounters: true, encounterEverySec: 60, maxConcurrent: 2, allowChaos: true, maxReactors: 4, disabledKinds: [] as string[] };
const LABELS = { pixelFont: true, showTitle: true, showTask: true, taskLines: 2, maxWidthChars: 20 };

function setup(over: { office?: Record<string, unknown>; reduced?: boolean; low?: boolean; multi?: boolean; hour?: number } = {}) {
  const state = { reduced: !!over.reduced, low: !!over.low, multi: !!over.multi, hour: over.hour ?? 12 };
  const office = { ambientEffects: true, showBubbles: true, labels: LABELS, npcs: { ...NPCS }, ...over.office };
  const spawned: FakeChar[] = [];
  const emitted: unknown[] = [];
  const steps: string[] = [];
  const scripted = new Map<string, 'running' | 'done'>();
  const reactions = { start: vi.fn(() => 1), step: vi.fn(), cancelAll: vi.fn(), cancelFor: vi.fn(), activeKeys: () => new Set() } as unknown as ReactionController & { start: ReturnType<typeof vi.fn>; step: ReturnType<typeof vi.fn>; cancelAll: ReturnType<typeof vi.fn>; cancelFor: ReturnType<typeof vi.fn> };
  let ctx!: NpcScriptCtx;
  const host = {
    map: () => ({ spawn: { x: 3, y: 4 } }),
    seats: () => ({ assign: vi.fn(), release: vi.fn() }),
    actors: () => new Map(),
    agents: () => [],
    theme: () => ({ id: 'modern' }),
    office: () => office,
    floorKey: () => 'f',
    reducedMotion: () => state.reduced,
    lowQuality: () => state.low,
    isMultiverse: () => state.multi,
    hour: () => state.hour,
    spawnNpc: (key: string, at: { x: number; y: number }) => {
      const c = new FakeChar(key, at);
      spawned.push(c);
      return c;
    },
    emit: (e: unknown) => emitted.push(e),
  } as unknown as NpcHost;
  const d = new NpcDirector(host, {
    createScriptRunner: (c) => {
      ctx = c;
      return {
        step: (npc: NpcActor) => {
          steps.push(`${npc.key}@${npc.stepIndex}`);
          return scripted.get(npc.key) ?? 'running';
        },
      };
    },
    createReactions: () => reactions,
  });
  return { d, spawned, emitted, steps, scripted, reactions, state, office, ctx: () => ctx };
}

let now = 1_000_000;
const tick = (d: NpcDirector, n = 1) => {
  for (let i = 0; i < n; i++) {
    now += 500;
    vi.setSystemTime(now);
    d.update(0, 500, 1);
  }
};
/** Advances until the first scheduled spawn (delay is 0.5..1.5 x encounterEverySec). */
const untilSpawn = (d: NpcDirector, s: { spawned: unknown[] }, max = 400) => {
  for (let i = 0; i < max && s.spawned.length === 0; i++) tick(d);
};

beforeEach(() => {
  vi.useFakeTimers();
  now = new Date(2026, 9, 1, 12).getTime();
  vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe('NpcDirector', () => {
  it('schedules the first NPC after a delay, not immediately', () => {
    const s = setup();
    tick(s.d, 2);
    expect(s.spawned).toHaveLength(0);
    untilSpawn(s.d, s);
    expect(s.spawned).toHaveLength(1);
    const c = s.spawned[0]!;
    expect(c.key).toMatch(/^npc:[a-z-]+:\d+$/);
    expect(c.at).toEqual({ x: 3, y: 4 });
    expect(c.activity).toEqual(['idle', 'active']);
    expect(s.d.npcs().get(c.key as never)).toBe(c);
  });

  it('applies the skin (look, costume, creature, plate options)', () => {
    const s = setup();
    untilSpawn(s.d, s);
    const c = s.spawned[0]!;
    expect(c.look).toMatchObject({ sprite: 0 });
    expect(c.costume).toEqual({});
    expect(c.creature).toBeNull();
    expect(c.plate).toBeDefined();
  });

  it('gates: disabled, ambientEffects off and Multiverse spawn nothing', () => {
    for (const over of [
      { office: { npcs: { ...NPCS, enabled: false } } },
      { office: { ambientEffects: false } },
      { multi: true },
    ]) {
      const s = setup(over);
      tick(s.d, 400);
      expect(s.spawned).toHaveLength(0);
    }
  });

  it('keeps one NPC per kind and respects maxConcurrent', () => {
    const s = setup({ office: { npcs: { ...NPCS, encounterEverySec: 30, maxConcurrent: 3 } } });
    tick(s.d, 600);
    const kinds = s.spawned.map((c) => c.key.split(':')[1]);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(s.spawned.length).toBeLessThanOrEqual(3);
    expect(s.spawned.length).toBeGreaterThan(0);
  });

  it('low quality caps NPCs at 1', () => {
    const s = setup({ low: true, office: { npcs: { ...NPCS, encounterEverySec: 30, maxConcurrent: 4 } } });
    tick(s.d, 600);
    expect(s.spawned).toHaveLength(1);
  });

  it('janitor comes in the evening, once per cooldown', () => {
    const s = setup({ hour: 20, office: { npcs: { ...NPCS, encounters: false, encounterEverySec: 86_400 } } });
    tick(s.d, 2);
    expect(s.spawned.map((c) => c.key.split(':')[1])).toEqual(['janitor']);
    s.scripted.set(s.spawned[0]!.key, 'done');
    tick(s.d, 2);
    expect(s.spawned).toHaveLength(1); // cooldown / same hour bucket
  });

  it('a reset (floor switch) keeps the janitor cooldown', () => {
    const s = setup({ hour: 20, office: { npcs: { ...NPCS, encounters: false, encounterEverySec: 86_400 } } });
    tick(s.d, 2);
    expect(s.spawned).toHaveLength(1);
    s.d.reset();
    tick(s.d, 3);
    expect(s.spawned).toHaveLength(1);
  });

  it('no janitor when the setting is off', () => {
    const s = setup({ hour: 20, office: { npcs: { ...NPCS, janitor: false, encounterEverySec: 86_400 } } });
    tick(s.d, 5);
    expect(s.spawned).toHaveLength(0);
  });

  it('removes and destroys an NPC once its script is done', () => {
    const s = setup();
    untilSpawn(s.d, s);
    const c = s.spawned[0]!;
    s.scripted.set(c.key, 'done');
    tick(s.d);
    expect(c.destroyed).toBe(true);
    expect(s.d.npcs().size).toBe(0);
    expect(s.reactions.cancelFor).toHaveBeenCalledTimes(1); // reactors stop chasing the removed NPC
  });

  it('reset destroys every NPC and cancels reactions (sendHome passes through)', () => {
    const s = setup();
    untilSpawn(s.d, s);
    s.d.reset({ sendHome: true });
    expect(s.spawned[0]!.destroyed).toBe(true);
    expect(s.d.npcs().size).toBe(0);
    expect(s.reactions.cancelAll).toHaveBeenLastCalledWith(true);
    s.d.reset();
    expect(s.reactions.cancelAll).toHaveBeenLastCalledWith(false);
  });

  it('turning NPCs off sends them to the exit step; reduced motion sends walkers out', () => {
    const s = setup();
    untilSpawn(s.d, s);
    const c = s.spawned[0]!;
    s.office.npcs.enabled = false;
    tick(s.d);
    const last = s.steps[s.steps.length - 1]!;
    const idx = Number(last.split('@')[1]);
    expect(idx).toBeGreaterThan(0);
    expect(c.destroyed).toBe(false);

    const r = setup();
    untilSpawn(r.d, r);
    r.state.reduced = true;
    tick(r.d);
    const rs = r.steps.filter((x) => x.startsWith(r.spawned[0]!.key));
    expect(Number(rs[rs.length - 1]!.split('@')[1])).toBeGreaterThan(0);
  });

  it('reduced motion spawns a static visit (enter, one bit, exit; no react, no janitor)', () => {
    const s = setup({ reduced: true });
    untilSpawn(s.d, s);
    expect(s.spawned).toHaveLength(1);
    expect(s.spawned[0]!.at).toEqual({ x: 3, y: 4 });
    const npc = (s.d as unknown as { actors: Map<string, NpcActor> }).actors.get(s.spawned[0]!.key)!;
    expect(npc.def.static).toBe(true);
    expect(npc.def.steps.map((x) => x.do)).toEqual(['enter', 'bit', 'exit']);
    expect(npc.def.steps.some((x) => x.do === 'bit' && x.react)).toBe(false);
    tick(s.d, 3);
    expect(s.spawned[0]!.destroyed).toBe(false);
    const j = setup({ reduced: true, hour: 20, office: { npcs: { ...NPCS, encounters: false, encounterEverySec: 86_400 } } });
    tick(j.d, 5);
    expect(j.spawned).toHaveLength(0);
  });

  it('hold / release / dismiss', () => {
    const s = setup();
    untilSpawn(s.d, s);
    const key = s.spawned[0]!.key;
    const id = key.replace(/^npc:/, '').replace(':', '-');
    expect(s.d.hold('nope')).toBe(false);
    expect(s.d.hold(id)).toBe(true);
    s.d.release(id);
    s.d.hold(id);
    s.d.dismiss(id);
    tick(s.d);
    const steps = s.steps.filter((x) => x.startsWith(key));
    expect(Number(steps[steps.length - 1]!.split('@')[1])).toBeGreaterThan(0);
    s.d.dismiss('nope');
  });

  it('setDim applies to live and future NPCs; characters tick every frame', () => {
    const s = setup();
    s.d.setDim(0.4);
    untilSpawn(s.d, s);
    expect(s.spawned[0]!.dim).toBe(0.4);
    s.d.setDim(0.7);
    expect(s.spawned[0]!.dim).toBe(0.7);
    const before = s.spawned[0]!.updates;
    s.d.update(0, 16, 1);
    expect(s.spawned[0]!.updates).toBe(before + 1);
  });

  it('ctx.react starts reactions only with chaos allowed and not on low quality; ctx.emit forwards events', () => {
    const s = setup();
    untilSpawn(s.d, s);
    const npc = { id: 'x-1', kind: 'guest' } as NpcActor;
    s.ctx().react(npc, 'flee', now);
    expect(s.reactions.start).toHaveBeenCalledTimes(1);
    s.state.low = true;
    s.ctx().react(npc, 'flee', now);
    expect(s.reactions.start).toHaveBeenCalledTimes(1);
    s.state.low = false;
    s.office.npcs.allowChaos = false;
    s.ctx().react(npc, 'flee', now);
    expect(s.reactions.start).toHaveBeenCalledTimes(1);
    s.ctx().emit(npc, 'bit', 5);
    expect(s.emitted[0]).toMatchObject({ id: 'x-1', kind: 'guest', style: 'modern', phase: 'bit', at: 5 });
  });
});
