import { describe, expect, it } from 'vitest';
import { dramaRng } from '../../drama';
import { CosmeticClaims } from '../../cosmetic/claims';
import type { GeneratedMap, Point } from '../../procgen/types';
import { ENCOUNTERS } from '../encounters';
import { createScriptRunner } from '../script';
import { NPC_TIMING, type EncounterDef, type EncounterEvent, type NpcActor, type NpcHost, type NpcScriptCtx } from '../types';
import type { SfxEvent } from '../../sfxBus';

// 12x8 grid: room "r1" at x 1..5, room "r2" at x 7..10 (y 1..4); hall everywhere else on rows 5..6.
function makeMap(): GeneratedMap {
  const cols = 12, rows = 8;
  const walkable = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => (x >= 1 && x <= 10 && y >= 1 && y <= 6 ? 0 : 1)));
  const roomAt = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x): string | null => (y >= 1 && y <= 4 && x >= 1 && x <= 5 ? 'r1' : y >= 1 && y <= 4 && x >= 7 && x <= 10 ? 'r2' : null)));
  const tilesOf = (id: string): Point[] => {
    const out: Point[] = [];
    roomAt.forEach((row, y) => row.forEach((r, x) => { if (r === id) out.push({ x, y }); }));
    return out;
  };
  return {
    cols, rows, walkable, roomAt, spawn: { x: 5, y: 6 },
    rooms: [{ id: 'r1', type: 'office', tiles: tilesOf('r1') }, { id: 'r2', type: 'lounge', tiles: tilesOf('r2') }],
    furniture: [{ kind: 'plant', x: 9, y: 2, w: 1, h: 1, blocking: true, roomId: 'r2', roomType: 'lounge', variant: 0 }],
  } as unknown as GeneratedMap;
}

class FakeChar {
  x = 5 * 16 + 8; y = 6 * 16 + 14; gone = false; leaving = false; isWaiting = false;
  lifecycleFrame = { state: 'resting' }; boundAgentId: string | null = null;
  pose: string | null = null; faceX: number | null | undefined; cb?: () => void; walks: Point[][] = []; said: string[] = [];
  get tile(): Point { return { x: Math.floor(this.x / 16), y: Math.floor((this.y - 1) / 16) }; }
  setPose(p: string | null) { this.pose = p; }
  face(x: number | null) { this.faceX = x; }
  walk(path: Point[], _s: boolean, cb?: () => void) { this.walks.push(path); this.cb = cb; this.target = path[path.length - 1]; }
  target?: Point;
  arrive() { if (this.target) { this.x = this.target.x * 16 + 8; this.y = this.target.y * 16 + 14; } const cb = this.cb; this.cb = undefined; this.target = undefined; cb?.(); }
  leave(path: Point[] | null) { this.leaving = true; this.leavePath = path; }
  leavePath: Point[] | null | undefined;
}

function setup(steps: EncounterDef['steps'], opts: { cast?: FakeChar[]; waiting?: Point[] } = {}) {
  const map = makeMap();
  const finder = { find: (a: Point, b: Point) => (a.x === b.x && a.y === b.y ? [a] : [a, b]) };
  const cast = new Map((opts.cast ?? []).map((c, i) => [`hero:${i}`, c]));
  const events: EncounterEvent['phase'][] = [];
  const sfx: SfxEvent[] = [];
  const said: { line: string; sec: number }[] = [];
  const reacts: string[] = [];
  const claims = new CosmeticClaims();
  const host = {
    map: () => map, finder: () => finder, actors: () => cast, agents: () => [], claims: () => claims,
    theme: () => ({ npcs: { skins: { courier: { name: 'C', color: 1, lines: ['hi'], jingle: 2, sound: 'whistle' } } } }),
  } as unknown as NpcHost;
  const ctx: NpcScriptCtx = {
    host, rng: dramaRng, say: (_c, line, sec) => said.push({ line, sec }), sfx: (e) => sfx.push(e),
    waitingTiles: () => opts.waiting ?? [], react: (_n, k) => reacts.push(k), emit: (_n, p) => events.push(p),
  };
  const char = new FakeChar();
  const def: EncounterDef = { ...ENCOUNTERS.courier, steps };
  const npc: NpcActor = { id: 'n', key: 'npc:courier:1', kind: 'courier', def, char: char as never, stepIndex: 0, stepAt: 0, held: false, scratch: {} };
  return { runner: createScriptRunner(ctx), npc, char, events, sfx, said, reacts, map };
}

describe('script runner', () => {
  it('runs enter, goto, bit, exit in order and emits events', () => {
    const t = setup([{ do: 'enter' }, { do: 'goto', target: 'entrance' }, { do: 'bit', pose: 'carry', sec: [4, 4], line: true, react: 'gather' }, { do: 'exit' }]);
    expect(t.runner.step(t.npc, 0)).toBe('running');
    expect(t.events).toEqual(['appeared']);
    expect(t.sfx.map((e) => e.id)).toEqual(['door-bell', 'npc-jingle-2']);
    expect(t.char.walks).toHaveLength(1);
    t.char.arrive();
    t.runner.step(t.npc, 500);
    expect(t.char.pose).toBe('carry');
    expect(t.said).toEqual([{ line: 'hi', sec: 4 }]);
    expect(t.reacts).toEqual(['gather']);
    expect(t.sfx.at(-1)?.id).toBe('whistle');
    t.runner.step(t.npc, 3000);
    expect(t.events).toEqual(['appeared', 'bit']);
    t.runner.step(t.npc, 4600);
    expect(t.events).toEqual(['appeared', 'bit', 'left']);
    expect(t.char.leaving).toBe(true);
    expect(t.char.leavePath?.at(-1)).toEqual(t.map.spawn);
    expect(t.runner.step(t.npc, 5000)).toBe('running');
    t.char.gone = true;
    expect(t.runner.step(t.npc, 5500)).toBe('done');
  });

  it('goto keeps clear of waiting characters and resolves each target kind', () => {
    const waiting = [{ x: 2, y: 2 }];
    for (const target of ['corridor', 'crowd', { rooms: ['lounge'] }, { furniture: ['plant'] }, 'entrance'] as const) {
      const t = setup([{ do: 'goto', target }, { do: 'exit' }], { waiting });
      t.runner.step(t.npc, 0);
      const to = t.char.walks[0]?.at(-1);
      expect(to, JSON.stringify(target)).toBeDefined();
      expect(Math.max(Math.abs(to!.x - 2), Math.abs(to!.y - 2))).toBeGreaterThan(2);
      if (target === 'corridor') expect(t.map.roomAt[to!.y]![to!.x]).toBeNull();
      if (typeof target === 'object' && 'rooms' in target) expect(t.map.roomAt[to!.y]![to!.x]).toBe('r2');
    }
  });

  it('goto times out and moves on', () => {
    const t = setup([{ do: 'goto', target: 'corridor' }, { do: 'bit', pose: 'cheer', sec: [1, 1] }, { do: 'exit' }]);
    t.runner.step(t.npc, 0);
    t.runner.step(t.npc, NPC_TIMING.stepTimeout - 1);
    expect(t.npc.stepIndex).toBe(0);
    t.runner.step(t.npc, NPC_TIMING.stepTimeout + 1);
    expect(t.npc.stepIndex).toBe(1);
  });

  it('wander visits n rooms and sweep pauses in pose sweep with a mop sfx', () => {
    const w = setup([{ do: 'wander', rooms: 2 }, { do: 'exit' }]);
    w.runner.step(w.npc, 0);
    w.char.arrive();
    w.runner.step(w.npc, 500);
    expect(w.char.walks).toHaveLength(2);
    w.char.arrive();
    w.runner.step(w.npc, 1000);
    expect(w.npc.stepIndex).toBe(1);

    const s = setup([{ do: 'sweep', tiles: 2 }, { do: 'exit' }]);
    s.runner.step(s.npc, 0);
    s.char.arrive();
    s.runner.step(s.npc, 500);
    expect(s.char.pose).toBe('sweep');
    expect(s.sfx.filter((e) => e.id === 'mop')).toHaveLength(1);
    s.runner.step(s.npc, 500 + NPC_TIMING.sweepPause);
    expect(s.char.walks).toHaveLength(2);
    s.char.arrive();
    s.runner.step(s.npc, 3000);
    s.runner.step(s.npc, 3000 + NPC_TIMING.sweepPause);
    expect(s.npc.stepIndex).toBe(1);
  });

  it('bit faces the nearest cast character', () => {
    const near = new FakeChar();
    near.x = 100;
    const t = setup([{ do: 'bit', pose: 'phone', sec: [1, 1] }, { do: 'exit' }], { cast: [near] });
    t.runner.step(t.npc, 0);
    expect(t.char.faceX).toBe(100);
  });

  it('held pauses the bit in pose chat and the clock, and release resumes', () => {
    const t = setup([{ do: 'bit', pose: 'cheer', sec: [2, 2] }, { do: 'exit' }]);
    t.runner.step(t.npc, 0);
    t.npc.held = true;
    t.runner.step(t.npc, 500);
    expect(t.char.pose).toBe('chat');
    t.runner.step(t.npc, 200_000);
    expect(t.npc.stepIndex).toBe(0);
    t.npc.held = false;
    t.runner.step(t.npc, 200_500);
    expect(t.char.pose).toBe('cheer');
    expect(t.npc.stepIndex).toBe(0);
    t.runner.step(t.npc, 203_000);
    expect(t.npc.stepIndex).toBe(1);
  });

  it('scriptMax forces the exit', () => {
    const t = setup([{ do: 'bit', pose: 'nap', sec: [999, 999] }, { do: 'exit' }]);
    t.runner.step(t.npc, 0);
    t.runner.step(t.npc, NPC_TIMING.scriptMax + 1);
    expect(t.char.leaving).toBe(true);
    expect(t.events).toContain('left');
  });

  it('a gone character finishes at once', () => {
    const t = setup([{ do: 'bit', pose: 'nap', sec: [9, 9] }, { do: 'exit' }]);
    t.char.gone = true;
    expect(t.runner.step(t.npc, 0)).toBe('done');
  });
});
