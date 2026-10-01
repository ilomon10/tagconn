import { describe, expect, it } from 'vitest';
import { CosmeticClaims } from '../../cosmetic/claims';
import { createReactions } from '../reactions';
import { NPC_TIMING, type NpcActor, type NpcHost } from '../types';

type Pt = { x: number; y: number };
class FakeChar {
  walking = false;
  leaving = false;
  gone = false;
  isWaiting = false;
  boundAgentId: string | null = null;
  lifecycleFrame = { state: 'resting', restingSince: 0 };
  emote: string | null = null;
  pose: string | null = 'x';
  faced: number | null | undefined;
  walks: Pt[] = [];
  cb?: () => void;
  constructor(public key: string, public tile: Pt, public x = 0) {}
  walk(path: Pt[], _s: boolean, cb?: () => void) {
    this.walks.push(path[path.length - 1]!);
    this.cb = cb;
    this.walking = path.length > 1;
    if (!this.walking) cb?.();
  }
  arrive() {
    this.walking = false;
    this.cb?.();
  }
  teleport(p: Pt) { this.tile = p; }
  setSeated() {}
  setDramaEmote(e: string | null) { this.emote = e; }
  clearDrama() { this.emote = null; }
  setPose(p: string | null) { this.pose = p; }
  face(x: number | null) { this.faced = x; }
}

function setup(over: { chaos?: boolean; low?: boolean; maxReactors?: number } = {}) {
  const walkable = Array.from({ length: 20 }, () => Array.from({ length: 20 }, () => 0));
  const roomAt = Array.from({ length: 20 }, () => Array.from({ length: 20 }, (): string | null => 'r'));
  const map = { walkable, roomAt, cols: 20, rows: 20 };
  const a = new FakeChar('hero:a', { x: 5, y: 5 });
  const b = new FakeChar('hero:b', { x: 6, y: 6 });
  const w = new FakeChar('hero:w', { x: 15, y: 15 });
  w.isWaiting = true;
  const actors = new Map<string, FakeChar>([[a.key, a], [b.key, b], [w.key, w]]);
  const homes = new Map([[a.key, { x: 1, y: 1, seated: true }], [b.key, { x: 2, y: 1, seated: true }]]);
  const claims = new CosmeticClaims();
  const seatCalls: string[] = [];
  const host = {
    map: () => map,
    finder: () => ({ find: (f: Pt, t: Pt) => (f.x === t.x && f.y === t.y ? [f] : [f, { x: (f.x + t.x) >> 1, y: (f.y + t.y) >> 1 }, t]) }),
    seats: () => ({
      get: (k: string) => homes.get(k as never),
      occupant: () => undefined,
      assign: () => seatCalls.push('assign'),
      release: () => seatCalls.push('release'),
    }),
    actors: () => actors,
    agents: () => [],
    office: () => ({ ambientEffects: true, npcs: { allowChaos: over.chaos ?? true, maxReactors: over.maxReactors ?? 4 } }),
    floorKey: () => 'f',
    reducedMotion: () => false,
    lowQuality: () => !!over.low,
    claims: () => claims,
  } as unknown as NpcHost;
  const npc = { id: 'n1', kind: 'monster', char: new FakeChar('npc:monster:1', { x: 7, y: 5 }, 120) } as unknown as NpcActor;
  const rx = createReactions(host, (s) => {
    let n = s.length;
    return () => ((n = (n * 31 + 7) % 1000) / 1000);
  });
  return { a, b, w, rx, npc, claims, seatCalls };
}

describe('npc reactions', () => {
  it('flee: reactors get alarm, walk >= 4 tiles away, and go home after the duration', () => {
    const { a, b, w, rx, npc, claims, seatCalls } = setup();
    expect(rx.start(npc, 'flee', 0)).toBe(2);
    expect(a.emote).toBe('alarm');
    expect(w.emote).toBeNull();
    expect(claims.holder(a.key as never)).toBe('reaction');
    expect(claims.holder(w.key as never)).toBeUndefined();
    expect(Math.hypot(a.walks[0]!.x - 7, a.walks[0]!.y - 5)).toBeGreaterThanOrEqual(4);
    a.arrive();
    rx.step(NPC_TIMING.reactMin - 1);
    expect(a.walks).toHaveLength(1);
    rx.step(NPC_TIMING.reactMin + NPC_TIMING.reactSpan + 1);
    expect(a.emote).toBeNull();
    expect(a.pose).toBeNull();
    expect(a.walks[1]).toMatchObject({ x: 1, y: 1 });
    b.arrive();
    a.arrive();
    expect(rx.activeKeys().size).toBe(0);
    expect(claims.count()).toBe(0);
    expect(claims.isTileReserved(a.walks[0]!)).toBe(false);
    expect(seatCalls).toEqual([]);
  });

  it('gather: heart for the cat, laugh otherwise, ring spot next to the NPC and faces it', () => {
    const { a, rx, npc } = setup();
    rx.start(npc, 'gather', 0);
    expect(a.emote).toBe('laugh');
    expect(a.faced).toBe(120);
    const t = a.walks[0]!;
    expect(Math.abs(t.x - 7) + Math.abs(t.y - 5)).toBe(1);
    const s2 = setup();
    (s2.npc as { kind: string }).kind = 'office-cat';
    s2.rx.start(s2.npc, 'gather', 0);
    expect(s2.a.emote).toBe('heart');
  });

  it('chase repaths toward the NPC every chaseRepath', () => {
    const { a, rx, npc } = setup();
    rx.start(npc, 'chase', 0);
    rx.step(0);
    expect(a.walks).toHaveLength(1);
    a.arrive();
    rx.step(NPC_TIMING.chaseRepath - 1);
    expect(a.walks).toHaveLength(1);
    rx.step(NPC_TIMING.chaseRepath);
    expect(a.walks).toHaveLength(2);
  });

  it('reactors go home when their NPC is gone, and cancelFor does the same at once', () => {
    const { a, b, rx, npc, claims } = setup();
    rx.start(npc, 'chase', 0);
    expect(rx.activeKeys().size).toBe(2);
    (npc.char as unknown as { gone: boolean }).gone = true;
    rx.step(10);
    expect(rx.activeKeys().size).toBe(0);
    expect(claims.holder(a.key as never)).toBeUndefined();
    expect(a.walks.at(-1)).toMatchObject({ x: 1, y: 1 });
    expect(b.walks.at(-1)).toMatchObject({ x: 2, y: 1 });
    const t = setup();
    t.rx.start(t.npc, 'chase', 0);
    t.rx.cancelFor(t.npc);
    expect(t.rx.activeKeys().size).toBe(0);
    expect(t.a.walks.at(-1)).toMatchObject({ x: 1, y: 1 });
  });

  it('duration is within bounds', () => {
    const { a, rx, npc } = setup();
    rx.start(npc, 'flee', 0);
    a.arrive();
    rx.step(NPC_TIMING.reactMin - 1);
    expect(rx.activeKeys().has(a.key as never)).toBe(true);
    rx.step(NPC_TIMING.reactMin + NPC_TIMING.reactSpan);
    expect(a.emote).toBeNull();
  });

  it('chaos off or low quality: nobody reacts; maxReactors caps', () => {
    for (const o of [{ chaos: false }, { low: true }]) {
      const s = setup(o);
      expect(s.rx.start(s.npc, 'flee', 0)).toBe(0);
    }
    const s = setup({ maxReactors: 1 });
    expect(s.rx.start(s.npc, 'flee', 0)).toBe(1);
  });

  it('a walking or non-idle character is not a candidate; a reactor turning waiting is released at once', () => {
    const { a, b, rx, npc, claims } = setup();
    a.walking = true;
    expect(rx.start(npc, 'flee', 0)).toBe(1);
    expect(a.emote).toBeNull();
    b.lifecycleFrame = { state: 'leaving' } as never;
    rx.step(10);
    expect(claims.holder(b.key as never)).toBeUndefined();
    expect(b.emote).toBeNull();
  });

  it('revoke by a meeting drops the key without moving it', () => {
    const { a, rx, npc, claims } = setup();
    rx.start(npc, 'flee', 0);
    const walks = a.walks.length;
    expect(claims.tryClaim(a.key as never, 'meeting', () => {})).toBe(true);
    expect(a.emote).toBeNull();
    expect(a.walks).toHaveLength(walks);
    expect(rx.activeKeys().has(a.key as never)).toBe(false);
    expect(claims.holder(a.key as never)).toBe('meeting');
  });

  it('reaction preempts a drama claim', () => {
    const { a, rx, npc, claims } = setup();
    let revoked = false;
    claims.tryClaim(a.key as never, 'drama', () => { revoked = true; });
    rx.start(npc, 'flee', 0);
    expect(revoked).toBe(true);
    expect(claims.holder(a.key as never)).toBe('reaction');
  });

  it('cancelAll sends everyone home (or drops in place) and releases claims', () => {
    const s = setup();
    s.rx.start(s.npc, 'flee', 0);
    s.a.arrive();
    s.rx.cancelAll(true);
    expect(s.a.walks.at(-1)).toMatchObject({ x: 1, y: 1 });
    expect(s.claims.count()).toBe(0);
    const t = setup();
    t.rx.start(t.npc, 'flee', 0);
    const n = t.a.walks.length;
    t.rx.cancelAll(false);
    expect(t.a.walks).toHaveLength(n);
    expect(t.claims.count()).toBe(0);
    expect(t.a.emote).toBeNull();
  });
});
