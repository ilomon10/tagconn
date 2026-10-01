import { describe, expect, it } from 'vitest';
import {
  buildBattleSetup, replay, ENGINE_VERSION, type BattleEvent, type BattleSetup, type PlayerAction,
} from '@tagconn/shared';
import { createBattleController } from '../controller';
import type { BattleController } from '../types';

const SKILLS = {};
const CURVE = { levelBase: 100, levelExponent: 1.5, maxLevel: 20 };

function fixture(): BattleSetup {
  return buildBattleSetup({
    seed: 7, npcKind: 'monster', difficulty: 0, maxTurns: 30, items: { coffee: 0, energyDrink: 0, rubberDuck: 0, pizza: 0 }, curve: CURVE,
    party: [
      { ref: { kind: 'agent', agentId: 'a1' }, name: 'Dev', role: 'developer', xp: 0, skills: SKILLS, temporary: false },
      { ref: { kind: 'agent', agentId: 'a2' }, name: 'QA', role: 'qa-engineer', xp: 0, skills: SKILLS, temporary: false },
    ],
  });
}

function make(durations: (e: BattleEvent) => number = () => 100, silent: (e: BattleEvent) => boolean = (e) => e.k === 'turn' || e.k === 'focus') {
  let t = 0;
  const setup = fixture();
  const c = createBattleController(setup, {
    text: (e) => (silent(e) ? '' : e.k),
    durationMs: (e) => durations(e),
    reduced: false,
    now: () => t,
  });
  return { c, setup, at: (ms: number) => { t = ms; return t; } };
}

/** Plays the whole timeline with a fake clock; returns the played event kinds. */
function drain(c: BattleController, at: (ms: number) => number, from = 0): { kinds: string[]; end: number } {
  const kinds: string[] = [];
  let now = from;
  let last = -1;
  for (let i = 0; i < 500 && c.view().busy; i++) {
    const cur = c.view().current;
    if (cur && cur.seq !== last) { kinds.push(cur.event.k); last = cur.seq; }
    now += 100;
    c.tick(at(now));
  }
  const cur = c.view().current;
  if (cur && cur.seq !== last) kinds.push(cur.event.k);
  return { kinds, end: now };
}

describe('battle controller', () => {
  it('starts idle', () => {
    const { c } = make();
    const v = c.view();
    expect(v.busy).toBe(false);
    expect(v.current).toBeNull();
    expect(v.lines).toEqual([]);
    expect(v.result).toBeNull();
  });

  it('plays events in order, one at a time, gating busy', () => {
    const { c, at } = make();
    expect(c.act({ t: 'move', move: 0 })).toEqual({ ok: true });
    expect(c.view().busy).toBe(true);
    expect(c.view().current?.seq).toBe(0);
    expect(c.view().current?.event.k).toBe('start');
    c.tick(at(99));
    expect(c.view().current?.seq).toBe(0);
    c.tick(at(100));
    expect(c.view().current?.seq).toBe(1);
    expect(c.view().current?.startedAt).toBe(100);
    const { kinds } = drain(c, at, 100);
    expect(kinds.length).toBeGreaterThan(2);
    expect(c.view().busy).toBe(false);
  });

  it('rejects act while busy and after destroy', () => {
    const { c, at } = make();
    c.act({ t: 'move', move: 0 });
    expect(c.act({ t: 'move', move: 0 })).toEqual({ ok: false, error: 'busy' });
    expect(c.actionLog()).toHaveLength(1);
    drain(c, at);
    c.destroy();
    expect(c.act({ t: 'move', move: 0 })).toEqual({ ok: false, error: 'destroyed' });
  });

  it('rejects an illegal action without queueing', () => {
    const { c } = make();
    expect(c.act({ t: 'move', move: 99 })).toEqual({ ok: false, error: 'bad-move' });
    expect(c.view().busy).toBe(false);
    expect(c.actionLog()).toEqual([]);
  });

  it('silent events take their duration without a log line', () => {
    const { c, at } = make();
    c.act({ t: 'move', move: 0 });
    const { kinds } = drain(c, at);
    const loud = kinds.filter((k) => k !== 'turn' && k !== 'focus');
    expect(c.view().lines).toEqual(loud);
  });

  it('skip ends the current item now and keeps every line', () => {
    const { c, at } = make(() => 10_000);
    c.act({ t: 'move', move: 0 });
    const first = c.view().current;
    at(50);
    c.skip();
    const second = c.view().current;
    expect(second?.seq).toBe((first?.seq ?? 0) + 1);
    expect(second?.startedAt).toBe(50);
    for (let i = 0; i < 100 && c.view().busy; i++) c.skip();
    expect(c.view().busy).toBe(false);
    expect(c.view().lines.length).toBeGreaterThan(0);
    c.skip(); // no-op when idle
  });

  it('sets result only after the end event has played, then reports ended', () => {
    const { c, at } = make(() => 100);
    let now = 0;
    let guard = 0;
    while (!c.view().result && guard++ < 400) {
      if (!c.view().busy) {
        const r = c.act({ t: 'move', move: 0 });
        if (!r.ok && r.error === 'swap-required') c.act({ t: 'swap', to: 1 });
        else if (!r.ok) throw new Error(r.error);
      }
      const view = c.view();
      if (view.current?.event.k === 'end') expect(view.result).toBeNull();
      now += 100;
      c.tick(at(now));
    }
    expect(c.view().result).not.toBeNull();
    expect(c.view().busy).toBe(false);
    expect(c.act({ t: 'move', move: 0 })).toEqual({ ok: false, error: 'ended' });
  });

  it('actionLog equals the accepted actions and replays to view().state', () => {
    const { c, setup, at } = make(() => 0);
    const accepted: PlayerAction[] = [];
    let now = 0;
    for (let i = 0; i < 400 && !c.view().result; i++) {
      if (!c.view().busy) {
        const a: PlayerAction = { t: 'move', move: 0 };
        const r = c.act(a);
        if (r.ok) accepted.push(a);
        else if (r.error === 'swap-required') { const s = c.act({ t: 'swap', to: 1 }); if (s.ok) accepted.push({ t: 'swap', to: 1 }); }
      }
      now += 1;
      c.tick(at(now));
    }
    expect(c.actionLog()).toEqual(accepted);
    const rp = replay(setup, c.actionLog());
    expect(rp.ok).toBe(true);
    if (rp.ok) expect(rp.state).toEqual(c.view().state);
    expect(setup.engineVersion).toBe(ENGINE_VERSION);
  });

  it('notifies subscribers with a stable view per change, until unsubscribed', () => {
    const { c, at } = make();
    const seen: unknown[] = [];
    const off = c.subscribe((v) => seen.push(v));
    c.act({ t: 'move', move: 0 });
    expect(seen).toHaveLength(1);
    expect(c.view()).toBe(c.view());
    expect(seen[0]).toBe(c.view());
    c.tick(at(10)); // too early: no emit
    expect(seen).toHaveLength(1);
    c.tick(at(100));
    expect(seen).toHaveLength(2);
    off();
    c.tick(at(200));
    expect(seen).toHaveLength(2);
  });

  it('treats invalid durations as zero', () => {
    const { c, at } = make(() => Number.NaN);
    c.act({ t: 'move', move: 0 });
    expect(c.view().current?.durationMs).toBe(0);
    c.tick(at(0));
    expect(c.view().current?.seq).toBe(1);
  });
});
