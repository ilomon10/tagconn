import { describe, expect, it } from 'vitest';
import type { ActorKey } from '../../cast';
import { CosmeticClaims } from '../../cosmetic/claims';
import type { PlacedFurniture, Point } from '../../procgen/types';
import type { LifeActivity } from '../../themes/types';
import { startActivity } from '../activity';
import { LIFE_TIMING, type ActivityPlan, type LifeCtx } from '../types';

class FakeChar {
  tile: Point;
  walking = false;
  pose: string | null = null;
  emote: string | null = null;
  faceX: number | null | undefined;
  said: string[] = [];
  homed = 0;
  constructor(x: number, y: number) {
    this.tile = { x, y };
  }
  setPose(p: string | null) { this.pose = p; }
  setDramaEmote(e: string | null) { this.emote = e; }
  face(x: number | null) { this.faceX = x; }
  clearDrama() { this.emote = null; }
}

const arcade: LifeActivity = {
  id: 'arcade', requires: ['arcade'], cast: [1, 2], weight: 1, durationSec: [10, 10], pose: 'play', emote: 'megaphone' as never,
  lines: ['one more round', 'boss fight'],
};
const stretch: LifeActivity = { ...arcade, id: 'stretch', requires: [], pose: 'stretch', emote: undefined, cast: [1, 1] };
const prop = { x: 5, y: 2, w: 2, h: 1 } as PlacedFurniture;

function setup(opts: { reduced?: boolean; ambient?: boolean } = {}) {
  const chars = new Map<string, FakeChar>([['a', new FakeChar(1, 1)], ['b', new FakeChar(1, 2)]]);
  const claims = new CosmeticClaims();
  const bad = new Set<string>();
  const homes: string[] = [];
  const said: Array<[string, string]> = [];
  const ctx = {
    host: {
      claims: () => claims,
      reducedMotion: () => !!opts.reduced,
      office: () => ({ ambientEffects: opts.ambient ?? true }),
      finder: () => ({
        find: (f: Point, t: Point) => (f.x === t.x && f.y === t.y ? [f] : [f, t]),
      }),
    },
    char: (k: string) => chars.get(k),
    eligible: (k: string) => !bad.has(k),
    goHome: (c: FakeChar) => { homes.push('home'); c.homed++; },
    say: (c: FakeChar, line: string) => { for (const [k, v] of chars) if (v === c) said.push([k, line]); },
    sfx: () => {},
    rng: () => { let i = 0; return () => ((i += 0.37) % 1); },
    isFree: () => true,
    isSitTile: () => false,
  } as unknown as LifeCtx;
  // Walks complete instantly: teleport in `walk`.
  for (const c of chars.values()) {
    (c as unknown as { walk: (p: Point[]) => void }).walk = (p) => { c.tile = p[p.length - 1]!; };
  }
  const plan = (act: LifeActivity, keys: string[], spots: Point[]): ActivityPlan => ({
    id: 'act1', activity: act, keys: keys as ActorKey[], prop: act.requires.length ? prop : null, spots, durationMs: 10_000, seed: 's',
  });
  return { chars, claims, ctx, bad, homes, said, plan };
}

describe('startActivity', () => {
  it('gathers, plays with pose/emote/lines, returns and releases everything', () => {
    const { chars, claims, ctx, plan, said, homes } = setup();
    const spots = [{ x: 5, y: 3 }, { x: 6, y: 3 }];
    const s = startActivity(ctx, plan(arcade, ['a', 'b'], spots), 0)!;
    expect(claims.count('activity')).toBe(2);
    expect(claims.isTileReserved(spots[0]!)).toBe(true);
    expect(s.step(0)).toBe('running');
    expect(claims.isTileReserved(spots[0]!)).toBe(false);
    expect(chars.get('a')!.pose).toBe('play');
    expect(chars.get('a')!.emote).toBe('megaphone');
    expect(chars.get('a')!.faceX).toBe(6 * 16);
    s.step(500);
    expect(said).toHaveLength(1);
    s.step(500 + LIFE_TIMING.lineEvery);
    expect(said).toHaveLength(2);
    s.step(10_000);
    expect(chars.get('a')!.pose).toBeNull();
    expect(chars.get('a')!.emote).toBeNull();
    expect(homes).toHaveLength(2);
    expect(s.step(10_500)).toBe('done');
    expect(claims.count()).toBe(0);
  });

  it('plays in place without walking and under reduced motion', () => {
    const { chars, claims, ctx, plan } = setup({ reduced: true });
    const s = startActivity(ctx, plan(stretch, ['a'], []), 0)!;
    expect(s).not.toBeNull();
    s.step(0);
    expect(chars.get('a')!.tile).toEqual({ x: 1, y: 1 });
    expect(chars.get('a')!.pose).toBe('stretch');
    expect(claims.count('activity')).toBe(1);
  });

  it('refuses a walking activity under reduced motion or ambient off, and bad plans', () => {
    const spots = [{ x: 5, y: 3 }, { x: 6, y: 3 }];
    let t = setup({ reduced: true });
    expect(startActivity(t.ctx, t.plan(arcade, ['a'], spots), 0)).toBeNull();
    t = setup({ ambient: false });
    expect(startActivity(t.ctx, t.plan(arcade, ['a'], spots), 0)).toBeNull();
    t = setup();
    expect(startActivity(t.ctx, t.plan(arcade, ['a', 'b'], spots.slice(0, 1)), 0)).toBeNull();
    t.bad.add('a');
    expect(startActivity(t.ctx, t.plan(arcade, ['a'], spots), 0)).toBeNull();
    expect(t.claims.count()).toBe(0);
  });

  it('fails cleanly when a key is already claimed', () => {
    const { claims, ctx, plan } = setup();
    claims.tryClaim('b' as ActorKey, 'drama', () => {});
    expect(startActivity(ctx, plan(arcade, ['a', 'b'], [{ x: 5, y: 3 }, { x: 6, y: 3 }]), 0)).toBeNull();
    expect(claims.holder('a' as ActorKey)).toBeUndefined();
    expect(claims.isTileReserved({ x: 5, y: 3 })).toBe(false);
  });

  it('breaks off a member that turns ineligible; the last one leaving ends the script', () => {
    const { chars, claims, ctx, plan, bad, homes } = setup();
    const s = startActivity(ctx, plan(arcade, ['a', 'b'], [{ x: 5, y: 3 }, { x: 6, y: 3 }]), 0)!;
    s.step(0);
    bad.add('b');
    s.step(500);
    expect(s.keys).toEqual(['a']);
    expect(claims.holder('b' as ActorKey)).toBeUndefined();
    expect(homes).toHaveLength(1);
    expect(chars.get('b')!.pose).toBeNull();
    bad.add('a');
    expect(s.step(1000)).toBe('done');
    expect(claims.count()).toBe(0);
  });

  it('times out the gather and drops those who did not arrive', () => {
    const { chars, ctx, plan, claims } = setup();
    (chars.get('b') as unknown as { walk: () => void }).walk = () => { chars.get('b')!.walking = true; };
    const s = startActivity(ctx, plan(arcade, ['a', 'b'], [{ x: 5, y: 3 }, { x: 6, y: 3 }]), 0)!;
    s.step(0);
    expect(chars.get('a')!.pose).toBeNull();
    s.step(LIFE_TIMING.convene);
    expect(s.keys).toEqual(['a']);
    expect(chars.get('a')!.pose).toBe('play');
    expect(claims.isTileReserved({ x: 6, y: 3 })).toBe(false);
    expect(chars.get('b')!.homed).toBe(1); // still walking toward the prop, yet sent home
  });

  it('revoke forgets the key without walking it; abort releases all', () => {
    const { chars, claims, ctx, plan, homes } = setup();
    const s = startActivity(ctx, plan(arcade, ['a', 'b'], [{ x: 5, y: 3 }, { x: 6, y: 3 }]), 0)!;
    s.step(0);
    expect(claims.tryClaim('a' as ActorKey, 'meeting', () => {})).toBe(true);
    expect(s.keys).toEqual(['b']);
    expect(chars.get('a')!.pose).toBeNull();
    expect(homes).toHaveLength(0);
    expect(claims.holder('a' as ActorKey)).toBe('meeting');
    s.abort();
    expect(claims.holder('b' as ActorKey)).toBeUndefined();
    expect(chars.get('b')!.pose).toBeNull();
    expect(s.step(100)).toBe('done');
  });

  it('cancel sends everyone home and finishes', () => {
    const { ctx, plan, claims, homes } = setup();
    const s = startActivity(ctx, plan(arcade, ['a', 'b'], [{ x: 5, y: 3 }, { x: 6, y: 3 }]), 0)!;
    s.step(0);
    s.cancel(100);
    expect(homes).toHaveLength(2);
    s.step(600);
    expect(s.step(700)).toBe('done');
    expect(claims.count()).toBe(0);
  });
});
