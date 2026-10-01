import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The pure pickers are T1's and tested there; here they are scripted so the state machine is under test.
const picks = vi.hoisted(() => ({
  cast: null as null | { roomId: string; keys: string[] },
  antic: null as unknown,
  strain: null as string | null,
  line: 'phew' as string | null,
}));
vi.mock('../drama', async (orig) => ({
  ...(await orig<typeof import('../drama')>()),
  pickCast: () => picks.cast,
  pickAntic: () => picks.antic,
  pickExchange: () => ['hi', 'yo'],
  nextDramaDelayMs: () => 1000,
  strainFor: () => picks.strain,
  strainLine: () => picks.line,
}));

import { DramaDirector, type DramaHost } from './dramaDirector';

type Pt = { x: number; y: number };
class FakeChar {
  walking = false;
  leaving = false;
  gone = false;
  boundAgentId: string | null = null;
  lifecycleFrame = { state: 'resting', restingSince: 0 };
  tile: Pt;
  emote: string | null = null;
  said: string[] = [];
  strain: [string | null, boolean] | null = null;
  walks: { to: Pt; seated: boolean }[] = [];
  private cb?: () => void;
  constructor(public key: string, x: number, y: number) {
    this.tile = { x, y };
  }
  walk(path: Pt[], seated: boolean, onArrive?: () => void) {
    this.walks.push({ to: path[path.length - 1]!, seated });
    this.cb = onArrive;
    this.walking = path.length > 1;
    if (!this.walking) onArrive?.();
  }
  /** Test helper: the walk finished. */
  arrive() {
    this.walking = false;
    const cb = this.cb;
    this.cb = undefined;
    cb?.();
  }
  teleport(p: Pt) {
    this.tile = p;
  }
  setSeated() {}
  setStrain(k: string | null, a: boolean) {
    this.strain = [k, a];
  }
  setDramaEmote(e: string | null) {
    this.emote = e;
  }
  sayDrama(t: string) {
    this.said.push(t);
  }
  clearDrama() {
    this.emote = null;
  }
}

const cooler = { kind: 'water-cooler', roomId: 'lounge', x: 5, y: 2, w: 1, h: 1, blocking: true, roomType: 'lounge', variant: 0 };
const map = () => {
  const walkable = Array.from({ length: 6 }, () => Array.from({ length: 8 }, () => 0));
  walkable[2]![5] = 1;
  const roomAt = Array.from({ length: 6 }, () => Array.from({ length: 8 }, (): string | null => 'lounge'));
  return { walkable, roomAt, furniture: [cooler] };
};

function setup(over: { office?: Record<string, unknown>; reduced?: boolean } = {}) {
  const a = new FakeChar('hero:a', 1, 4);
  const b = new FakeChar('hero:b', 2, 4);
  const actors = new Map<string, FakeChar>([[a.key, a], [b.key, b]]);
  const m = map();
  const seatOf = (c: FakeChar) => ({ x: c.tile.x, y: c.tile.y, seated: true });
  const homes = new Map([[a.key, { x: 1, y: 4, seated: true }], [b.key, { x: 2, y: 4, seated: true }]]);
  const agents: unknown[] = [];
  const office = {
    showBubbles: true,
    ambientEffects: true,
    maxBubbles: 6,
    drama: { enabled: true, idleChatSec: 45, tiredAfterSec: 1, dizzyToolSec: 1, sweatAfterSec: 1, streakTools: 8, streakWindowSec: 60 },
    ...over.office,
  };
  const host = {
    map: () => m,
    finder: () => ({ find: (from: Pt, to: Pt) => (from.x === to.x && from.y === to.y ? [from] : [from, to]) }),
    seats: () => ({ get: (k: string) => homes.get(k), occupant: () => undefined }),
    actors: () => actors,
    agents: () => agents,
    themeFor: () => ({}),
    office: () => office,
    floorKey: () => 'f',
    reducedMotion: () => !!over.reduced,
  };
  void seatOf;
  const d = new DramaDirector(host as unknown as DramaHost);
  picks.cast = { roomId: 'lounge', keys: [a.key, b.key] };
  picks.antic = { id: 'x', props: ['water-cooler'], cast: 2, emote: 'mug', lines: [['hi', 'yo']] };
  return { a, b, d, agents, office };
}

let now = 1_000_000;
const tick = (d: DramaDirector, ms: number) => {
  now += ms;
  vi.setSystemTime(now);
  d.update(0, 500);
};

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000_000;
  vi.setSystemTime(now);
  picks.strain = null;
  picks.line = 'phew';
});
afterEach(() => vi.useRealTimers());

/** Schedule, fire and return the running scene's chars. */
function start(d: DramaDirector) {
  tick(d, 500); // schedules (+1000)
  tick(d, 1500); // fires
  picks.cast = null; // one scene per test
}

describe('DramaDirector scenes', () => {
  it('gathers at the prop, plays emote + lines, then walks home', () => {
    const { a, b, d } = setup();
    start(d);
    expect(a.walks).toHaveLength(1);
    expect(b.walks).toHaveLength(1);
    expect(a.walks[0]!.seated).toBe(false);
    expect(Math.abs(a.walks[0]!.to.x - 5) + Math.abs(a.walks[0]!.to.y - 2)).toBe(1);
    a.arrive();
    b.arrive();
    tick(d, 500);
    expect(a.emote).toBe('mug');
    expect(b.emote).toBe('mug');
    expect(a.said).toEqual(['hi']);
    tick(d, 2000);
    expect(b.said).toEqual(['yo']);
    tick(d, 10_000);
    expect(a.emote).toBeNull();
    expect(a.walks).toHaveLength(2);
    expect(a.walks[1]!.to).toEqual({ x: 1, y: 4 });
    expect(a.walks[1]!.seated).toBe(true);
  });

  it('reduced motion acts in place, with no walking', () => {
    const { a, b, d } = setup({ reduced: true });
    start(d);
    expect(a.walks).toHaveLength(0);
    tick(d, 500);
    expect(a.emote).toBe('mug');
    expect(b.emote).toBe('mug');
  });

  it('showBubbles off: emote only', () => {
    const { a, d } = setup({ office: { showBubbles: false }, reduced: true });
    start(d);
    tick(d, 500);
    tick(d, 3000);
    expect(a.emote).toBe('mug');
    expect(a.said).toEqual([]);
  });

  it('never starts with drama disabled or ambientEffects off', () => {
    for (const off of [{ drama: { enabled: false } }, { ambientEffects: false }]) {
      const { a, d, office } = setup();
      Object.assign(office, off);
      if ('drama' in off) office.drama = { ...office.drama, ...off.drama };
      start(d);
      expect(a.walks).toHaveLength(0);
    }
  });

  it('cancel: the partner walks home, an ineligible walking actor is left alone', () => {
    const { a, b, d, agents } = setup();
    start(d);
    a.arrive();
    b.arrive();
    tick(d, 500);
    // a becomes a working quest agent and is sent elsewhere by updateCast
    a.lifecycleFrame = { state: 'quest', restingSince: 0 };
    a.boundAgentId = 'ag';
    agents.push({ id: 'ag', status: 'active', activity: 'typing', toolCount: 0 });
    a.walking = true;
    const aWalks = a.walks.length;
    d.afterCast(now);
    expect(a.walks).toHaveLength(aWalks);
    expect(b.walks[b.walks.length - 1]!.to).toEqual({ x: 2, y: 4 });
    expect(b.emote).toBeNull();
  });

  it('cancel: an ineligible actor that is not walking returns home too', () => {
    const { a, d } = setup();
    start(d);
    a.arrive();
    d.update(0, 500);
    a.leaving = false;
    a.lifecycleFrame = { state: 'quest', restingSince: 0 }; // no bound agent: ineligible
    d.afterCast(now);
    expect(a.walks[a.walks.length - 1]!.to).toEqual({ x: 1, y: 4 });
  });

  it('gather timeout sends everyone home', () => {
    const { a, d } = setup();
    start(d);
    tick(d, 7000);
    expect(a.walks[a.walks.length - 1]!.to).toEqual({ x: 1, y: 4 });
    expect(a.emote).toBeNull();
  });

  it('reset drops scenes without touching characters', () => {
    const { a, d } = setup();
    start(d);
    const n = a.walks.length;
    d.reset();
    tick(d, 500);
    expect(a.walks).toHaveLength(n);
  });
});

describe('DramaDirector strain', () => {
  function quest(over?: Parameters<typeof setup>[0]) {
    const s = setup(over);
    s.a.lifecycleFrame = { state: 'quest', restingSince: 0 };
    s.a.boundAgentId = 'ag';
    s.agents.push({ id: 'ag', status: 'active', activity: 'typing', toolCount: 0 });
    return s;
  }

  it('sets the strain, animated by default, and says one line on the null to kind transition', () => {
    const { a, d } = quest();
    d.afterCast(now); // first observation: calm, recorded
    picks.strain = 'dizzy';
    d.afterCast(now);
    expect(a.strain).toEqual(['dizzy', true]);
    expect(a.said).toEqual(['phew']);
    d.afterCast(now);
    expect(a.said).toEqual(['phew']);
  });

  it('is static under reduced motion or ambientEffects off, and off when disabled', () => {
    for (const o of [{ reduced: true }, { office: { ambientEffects: false } }]) {
      const { a, d } = quest(o);
      picks.strain = 'tired';
      d.afterCast(now);
      expect(a.strain).toEqual(['tired', false]);
    }
    const { a, d, office } = quest();
    picks.strain = 'tired';
    office.drama.enabled = false;
    d.afterCast(now);
    expect(a.strain).toEqual([null, false]);
  });

  it('resting actors are cleared', () => {
    const { b, d } = quest();
    picks.strain = 'tired';
    d.afterCast(now);
    expect(b.strain).toEqual([null, false]);
  });
});
