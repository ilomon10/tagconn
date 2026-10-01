import { NPC_KINDS, type NpcKind } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { dramaRng } from '../../drama';
import { ENCOUNTERS } from '../encounters';
import { BURST_TOOLS, BurstMeter, fleeTarget, janitorDue, nextEncounterDelayMs, npcSkin, pickEncounter, pickReactors } from '../rules';
import type { NpcSettings } from '../types';

const S: NpcSettings = { enabled: true, janitor: true, encounters: true, encounterEverySec: 240, maxConcurrent: 2, allowChaos: true, maxReactors: 4, disabledKinds: [] };

describe('pickEncounter', () => {
  it('never returns janitor, disabled, active or zero-hour kinds', () => {
    const rand = dramaRng('a');
    const seen = new Set<NpcKind>();
    for (let i = 0; i < 400; i++) {
      const d = pickEncounter(12, rand, { ...S, disabledKinds: ['police'] }, new Set<NpcKind>(['guest']));
      if (d) seen.add(d.kind);
    }
    expect(seen.has('janitor')).toBe(false);
    expect(seen.has('police')).toBe(false);
    expect(seen.has('guest')).toBe(false);
    expect(seen.has('monster')).toBe(false); // zero at noon
    expect(seen.has('courier')).toBe(true);
  });
  it('encounters:false is routine only; enabled:false is null', () => {
    const rand = dramaRng('b');
    for (let i = 0; i < 100; i++) expect(pickEncounter(10, rand, { ...S, encounters: false })?.routine).toBe(true);
    expect(pickEncounter(10, rand, { ...S, enabled: false })).toBeNull();
  });
  it('returns null when everything is excluded', () => {
    expect(pickEncounter(12, () => 0.5, { ...S, disabledKinds: [...NPC_KINDS] })).toBeNull();
  });
  it('respects weights', () => {
    const rand = dramaRng('hist');
    const n: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const k = pickEncounter(12, rand, S)?.kind ?? 'none';
      n[k] = (n[k] ?? 0) + 1;
    }
    // noon weights: courier 3, guest 3, police 1, sales-dog 2, office-cat 3 (cat x1)
    expect(n.courier! / n.police!).toBeGreaterThan(2);
    expect(n.courier! / n['sales-dog']!).toBeGreaterThan(1.1);
    expect(n['sales-dog']! / n.police!).toBeGreaterThan(1.4);
  });
});

describe('janitorDue', () => {
  const H = 3_600_000;
  it('mops once per evening hour, bins on burst, honours cooldown and settings', () => {
    expect(janitorDue(19, false, null, 100 * H, S)).toBe('mop');
    expect(janitorDue(12, false, null, 100 * H, S)).toBeNull();
    expect(janitorDue(19, false, 100 * H + 1000, 100 * H + 700_000, S)).toBeNull(); // same hour bucket
    expect(janitorDue(19, false, 99 * H + 1000, 100 * H + 1000, S)).toBe('mop');
    expect(janitorDue(12, true, null, 100 * H, S)).toBe('bins');
    expect(janitorDue(12, true, 100 * H - 1000, 100 * H, S)).toBeNull(); // cooldown
    expect(janitorDue(19, true, null, 0, { ...S, janitor: false })).toBeNull();
    expect(janitorDue(19, true, null, 0, { ...S, disabledKinds: ['janitor'] })).toBeNull();
    expect(janitorDue(19, true, null, 0, { ...S, enabled: false })).toBeNull();
  });
});

describe('BurstMeter', () => {
  it('detects a floor-wide rise within the window and expires', () => {
    const m = new BurstMeter();
    m.observe([{ id: 'a', toolCount: 5 }, { id: 'b', toolCount: 0 }], 0);
    expect(m.burst(0)).toBe(false);
    m.observe([{ id: 'a', toolCount: 5 + 7 }, { id: 'b', toolCount: 5 }], 10_000);
    expect(BURST_TOOLS).toBe(12);
    expect(m.burst(10_000)).toBe(true);
    expect(m.burst(80_000)).toBe(false);
    m.clear();
    expect(m.burst(10_000)).toBe(false);
  });
});

describe('pickReactors', () => {
  const npc = { x: 10, y: 10 };
  const cs = [
    { key: 'a' as never, x: 12, y: 10 }, { key: 'b' as never, x: 11, y: 10 },
    { key: 'far' as never, x: 30, y: 10 }, { key: 'c' as never, x: 8, y: 10 },
  ];
  it('is nearest first, in range, capped', () => {
    expect(pickReactors(cs, npc, [], 2, 's')).toEqual(['b', 'a']);
    expect(pickReactors(cs, npc, [], 10, 's')).not.toContain('far');
  });
  it('keeps clearance from waiting tiles', () => {
    expect(pickReactors(cs, npc, [{ x: 12, y: 11 }], 10, 's')).toEqual(['c']);
  });
});

describe('fleeTarget', () => {
  const cols = 12, rows = 4;
  const walkable = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  const roomAt = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => (y < 2 ? 'r1' : x < 6 ? 'r2' : null)));
  const map = { walkable, roomAt, cols, rows };
  it('is >= 4 tiles from the threat, prefers the room, respects isFree', () => {
    const p = fleeTarget(map, { x: 3, y: 0 }, { x: 2, y: 0 }, () => 0, () => true)!;
    expect(Math.hypot(p.x - 2, p.y - 0)).toBeGreaterThanOrEqual(4);
    expect(roomAt[p.y]![p.x]).toBe('r1');
    const q = fleeTarget(map, { x: 3, y: 0 }, { x: 2, y: 0 }, () => 0, (t) => t.y > 1)!;
    expect(q.y).toBeGreaterThan(1);
    expect(fleeTarget(map, { x: 3, y: 0 }, { x: 2, y: 0 }, () => 0, () => false)).toBeNull();
  });
});

describe('delay and skin', () => {
  it('delay is seeded within 0.5..1.5 x every', () => {
    const d = nextEncounterDelayMs('f', 3, 240);
    expect(d).toBe(nextEncounterDelayMs('f', 3, 240));
    expect(d).toBeGreaterThanOrEqual(120_000);
    expect(d).toBeLessThan(360_000);
  });
  it('npcSkin falls back to a neutral skin', () => {
    const s = npcSkin({}, 'cia-agent');
    expect(s.name).toBe('Cia Agent');
    expect(s.color).toBe(0x8e8e9e);
    expect(npcSkin({ npcs: { skins: { police: { name: 'P', color: 1, lines: [], jingle: 1 } } as never } }, 'police').name).toBe('P');
    expect(ENCOUNTERS.police.kind).toBe('police');
  });
});
