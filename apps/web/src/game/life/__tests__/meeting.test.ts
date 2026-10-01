import { describe, expect, it, vi } from 'vitest';
import { CosmeticClaims } from '../../cosmetic/claims';
import { startMeeting } from '../meeting';
import { LIFE_TIMING, type LifeCtx, type MeetingPlan } from '../types';

type Pt = { x: number; y: number };
class FakeChar {
  walking = false;
  leaving = false;
  gone = false;
  x: number;
  emote: string | null = null;
  pose: string | null = null;
  faceX: number | null | undefined;
  said: string[] = [];
  walks: { to: Pt; seated: boolean }[] = [];
  private cb?: () => void;
  private dest: Pt | null = null;
  /** Walks finish only when the test says so. */
  manual = true;
  constructor(public key: string, public tile: Pt) {
    this.x = tile.x * 16 + 8;
  }
  walk(path: Pt[], seated: boolean, onArrive?: () => void) {
    this.dest = path[path.length - 1]!;
    this.walks.push({ to: this.dest, seated });
    this.cb = onArrive;
    this.walking = path.length > 1;
    if (!this.walking) {
      this.tile = this.dest;
      onArrive?.();
    }
  }
  arrive() {
    if (this.dest) this.tile = this.dest;
    this.x = this.tile.x * 16 + 8;
    this.walking = false;
    const cb = this.cb;
    this.cb = undefined;
    cb?.();
  }
  setDramaEmote(e: string | null) { this.emote = e; }
  setPose(p: string | null) { this.pose = p; }
  face(x: number | null) { this.faceX = x; }
  clearDrama() { this.emote = null; }
}

const ids = ['host', 'a', 'b'] as const;
function setup(opts: { straggler?: string | null; kind?: 'kickoff' | 'standup' } = {}) {
  const claims = new CosmeticClaims();
  const chars = new Map<string, FakeChar>();
  const starts: Record<string, Pt> = { host: { x: 1, y: 1 }, a: { x: 8, y: 2 }, b: { x: 9, y: 4 } };
  for (const k of ids) chars.set(k, new FakeChar(k, starts[k]!));
  const eligible = vi.fn((_k: string, _r: string) => true);
  const homes: string[] = [];
  const said: { k: string; line: string }[] = [];
  const sfx = vi.fn();
  let reduced = false;
  const map = {
    rooms: [{ id: 'r', interior: { x: 3, y: 3, w: 4, h: 4 } }],
    walkable: Array.from({ length: 12 }, () => Array.from({ length: 12 }, () => 0)),
    roomAt: Array.from({ length: 12 }, () => Array.from({ length: 12 }, (): string | null => 'r')),
  };
  const ctx = {
    host: {
      map: () => map,
      finder: () => ({ find: (from: Pt, to: Pt) => [from, to] }),
      claims: () => claims,
      reducedMotion: () => reduced,
      office: () => ({ ambientEffects: true }),
      seats: () => ({ assign: vi.fn(), release: vi.fn(), get: () => undefined }),
    },
    char: (k: string) => chars.get(k),
    eligible,
    goHome: (c: FakeChar) => { homes.push(c.key); },
    say: (c: FakeChar, line: string) => { said.push({ k: c.key, line }); },
    sfx,
    rng: () => () => 0.3,
    isFree: () => true,
    isSitTile: (p: Pt) => p.x === 4,
  } as unknown as LifeCtx;
  const plan: MeetingPlan = {
    id: 'm1',
    kind: opts.kind ?? 'kickoff',
    hostKey: 'host' as never,
    inviteeKeys: ['a', 'b'] as never[],
    stragglerKey: (opts.straggler === undefined ? 'b' : opts.straggler) as never,
    venue: { roomId: 'r', table: { x: 4, y: 4, w: 2, h: 1 } as never, spots: [{ x: 3, y: 4 }, { x: 4, y: 3 }, { x: 5, y: 3 }] },
    lines: { invite: ['gather!'], fetch: ['where are you'], dawdle: ['coming'], talk: ['hm'], close: ['bye'] },
    meetingMs: 10_000,
    seed: 's',
  };
  return { ctx, plan, claims, chars, eligible, homes, said, sfx, setReduced: (v: boolean) => (reduced = v) };
}

const arriveAll = (chars: Map<string, FakeChar>) => chars.forEach((c) => c.walking && c.arrive());

describe('startMeeting', () => {
  it('invites with emotes, a line and the gong, claiming and reserving spots', () => {
    const t = setup();
    const s = startMeeting(t.ctx, t.plan, 0)!;
    expect(s).not.toBeNull();
    expect(t.chars.get('a')!.emote).toBe('megaphone');
    expect(t.said[0]).toEqual({ k: 'host', line: 'gather!' });
    expect(t.sfx).toHaveBeenCalledWith(expect.objectContaining({ id: 'meeting-gong' }));
    expect(t.claims.count('meeting')).toBe(3);
    expect(t.claims.isTileReserved({ x: 4, y: 3 })).toBe(true);
  });

  it('fetches the straggler, then holds the meeting, disperses and releases everything', () => {
    const t = setup();
    const s = startMeeting(t.ctx, t.plan, 0)!;
    s.step(LIFE_TIMING.inviteEmote);
    const [host, a, b] = ['host', 'a', 'b'].map((k) => t.chars.get(k)!) as [FakeChar, FakeChar, FakeChar];
    expect(host.walks.at(-1)!.to).toEqual({ x: 3, y: 4 });
    expect(a.walks.at(-1)).toEqual({ to: { x: 4, y: 3 }, seated: true });
    expect(b.pose).toBe('phone');
    expect(b.walks.at(-1)!.to).not.toEqual({ x: 5, y: 3 });
    // Non-stragglers arrive: the host heads for the straggler.
    host.arrive(); a.arrive();
    let now = 3000;
    s.step(now);
    expect(host.emote).toBe('alarm');
    const toStraggler = host.walks.at(-1)!.to;
    expect(Math.abs(toStraggler.x - b.tile.x) + Math.abs(toStraggler.y - b.tile.y)).toBe(1);
    host.arrive();
    now += 500; s.step(now);
    expect(t.said.at(-1)).toEqual({ k: 'host', line: 'where are you' });
    now += LIFE_TIMING.replyDelay; s.step(now);
    expect(t.said.at(-1)).toEqual({ k: 'b', line: 'coming' });
    expect(b.pose).toBeNull();
    expect(host.walks.at(-1)!.to).toEqual({ x: 3, y: 4 });
    expect(b.walks.at(-1)!.to).toEqual({ x: 5, y: 3 });
    arriveAll(t.chars);
    now += 500; s.step(now);
    // Meeting phase: poses, facing the table, spots released.
    expect(a.pose).toBe('sit');
    expect(b.pose).toBe('chat');
    expect(a.faceX).toBe(80);
    expect(t.claims.isTileReserved({ x: 4, y: 3 })).toBe(false);
    now += LIFE_TIMING.lineEvery; s.step(now);
    expect(t.said.at(-1)!.line).toBe('hm');
    now += 10_000; s.step(now);
    expect(t.said.at(-1)).toEqual({ k: 'host', line: 'bye' });
    expect(t.homes.sort()).toEqual(['a', 'b', 'host']);
    // Everyone is home (not walking): the next step finishes and frees every claim.
    expect(s.step(now + 500)).toBe('done');
    expect(t.claims.count()).toBe(0);
    expect(a.pose).toBeNull();
  });

  it('releases a straggler that never answers, and the meeting carries on', () => {
    const t = setup();
    const s = startMeeting(t.ctx, t.plan, 0)!;
    s.step(2000);
    const host = t.chars.get('host')!;
    host.arrive(); t.chars.get('a')!.arrive();
    s.step(3000);
    // Host never reaches the straggler: fetch times out.
    s.step(3000 + LIFE_TIMING.fetch);
    expect(t.claims.holder('b' as never)).toBeUndefined();
    expect(t.chars.get('b')!.pose).toBeNull();
    host.arrive();
    s.step(3000 + LIFE_TIMING.fetch + 500);
    expect(t.chars.get('a')!.pose).toBe('sit');
    expect(s.keys).toEqual(['host', 'a']);
  });

  it('sends home those who miss the convene timeout and still meets', () => {
    const t = setup({ straggler: null });
    const s = startMeeting(t.ctx, t.plan, 0)!;
    s.step(2000);
    t.chars.get('host')!.arrive();
    t.chars.get('a')!.arrive();
    s.step(2000 + LIFE_TIMING.convene);
    expect(s.keys).toEqual(['host', 'a']);
    expect(t.claims.holder('b' as never)).toBeUndefined();
    expect(t.chars.get('a')!.pose).toBe('sit');
  });

  it('breaks off an ineligible invitee (left alone if walking, sent home if not) and ends when the host is lost', () => {
    const t = setup({ straggler: null });
    const s = startMeeting(t.ctx, t.plan, 0)!;
    s.step(2000);
    t.chars.get('host')!.arrive();
    t.eligible.mockImplementation((k) => k !== 'a');
    s.step(2500);
    expect(s.keys).toEqual(['host', 'b']);
    expect(t.homes).toEqual([]); // 'a' was still walking
    expect(t.claims.holder('a' as never)).toBeUndefined();
    t.eligible.mockImplementation((k) => k !== 'host');
    s.step(3000);
    expect(t.homes).toContain('b');
    t.chars.get('b')!.arrive(); // the walks home (started by goHome in a real scene) is over
    expect(s.step(3500)).toBe('done');
    expect(t.claims.count()).toBe(0);
  });

  it('ends with fewer than two participants', () => {
    const t = setup({ straggler: null });
    const s = startMeeting(t.ctx, t.plan, 0)!;
    t.eligible.mockImplementation((k) => k === 'host');
    s.step(500);
    // Nobody was walking yet (still inviting), so the released ones head home; the lone host disperses too.
    expect(t.homes.sort()).toEqual(['a', 'b', 'host']);
    expect(s.step(1000)).toBe('done');
    expect(t.claims.count()).toBe(0);
  });

  it('revoke drops the key without moving it', () => {
    const t = setup();
    const s = startMeeting(t.ctx, t.plan, 0)!;
    const walks = t.chars.get('a')!.walks.length;
    t.claims.tryClaim('a' as never, 'meeting', () => {}); // same priority never preempts
    expect(t.claims.holder('a' as never)).toBe('meeting');
    s.revoke('a' as never, 100);
    expect(s.keys).toEqual(['host', 'b']);
    expect(t.chars.get('a')!.emote).toBeNull();
    expect(t.chars.get('a')!.walks.length).toBe(walks);
    expect(t.homes).toEqual([]);
  });

  it('abort releases every claim and tile without walking', () => {
    const t = setup();
    const s = startMeeting(t.ctx, t.plan, 0)!;
    s.step(2000);
    s.abort();
    expect(t.claims.count()).toBe(0);
    expect(t.claims.isTileReserved({ x: 4, y: 3 })).toBe(false);
    expect(t.homes).toEqual([]);
    expect(s.step(2500)).toBe('done');
  });

  it('cancel disperses everyone; reduced motion cancels a running meeting and refuses a new one', () => {
    const t = setup();
    const s = startMeeting(t.ctx, t.plan, 0)!;
    s.step(2000);
    t.setReduced(true);
    s.step(2500);
    expect(t.homes.sort()).toEqual(['a', 'b', 'host']);
    expect(startMeeting(t.ctx, { ...t.plan, id: 'm2' }, 0)).toBeNull();
  });

  it('never starts when a character is already in a higher claim, and rolls back', () => {
    const t = setup();
    t.claims.tryClaim('a' as never, 'meeting', () => {});
    // Already held by another meeting: refused, and only the claims this begin() took are rolled back.
    expect(startMeeting(t.ctx, t.plan, 0)).toBeNull();
    expect(t.claims.count()).toBe(1);
    expect(t.claims.holder('a' as never)).toBe('meeting');
    const u = setup();
    u.claims.tryClaim('b' as never, 'reaction', () => {});
    expect(startMeeting(u.ctx, u.plan, 0)).not.toBeNull(); // meeting preempts reaction
    const v = setup();
    expect(startMeeting(v.ctx, { ...v.plan, inviteeKeys: [], stragglerKey: null }, 0)).toBeNull();
    expect(v.claims.count()).toBe(0);
  });

  it('never calls SeatAllocator assign/release', () => {
    const t = setup();
    const seats = t.ctx.host.seats() as unknown as { assign: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
    const s = startMeeting(t.ctx, t.plan, 0)!;
    s.step(2000); s.abort();
    expect(seats.assign).not.toHaveBeenCalled();
    expect(seats.release).not.toHaveBeenCalled();
  });
});
