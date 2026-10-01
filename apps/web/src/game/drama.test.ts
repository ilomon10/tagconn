import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@tagconn/shared';
import {
  EMPTY_DRAMA, StreakTracker, isAgentOnARoll, observeAgents, resetStreaks, dramaBucket, dramaFor, dramaRng, nextDramaDelayMs, pickAntic, pickCast, pickExchange, strainFor, strainLine,
  type DramaCandidate, type StrainInput,
} from './drama';
import { guildTheme } from './themes/guild';
import { modernTheme } from './themes/modern';
import { riftTheme } from './themes/rift';
import { STRAIN_PRIORITY, type DramaContent } from './themes/types';
import type { FurnitureKind } from './procgen/types';

const cfg = SettingsSchema.parse({}).office.drama;
const NOW = 10_000_000;
const calm: StrainInput = { status: 'active', activity: 'typing', startedAt: NOW - 1000, updatedAt: NOW - 1000 };

describe('strainFor', () => {
  it('is null when calm', () => expect(strainFor(calm, NOW, cfg, false)).toBeNull());
  it('is null when disabled or done', () => {
    const long = { ...calm, startedAt: 0, toolStartedAt: 0 };
    expect(strainFor(long, NOW, { ...cfg, enabled: false }, true)).toBeNull();
    expect(strainFor({ ...long, status: 'done' }, NOW, cfg, true)).toBeNull();
  });
  it('dizzy at the dizzyToolSec boundary', () => {
    const ms = cfg.dizzyToolSec * 1000;
    expect(strainFor({ ...calm, toolStartedAt: NOW - ms + 1 }, NOW, cfg, false)).toBeNull();
    expect(strainFor({ ...calm, toolStartedAt: NOW - ms }, NOW, cfg, false)).toBe('dizzy');
  });
  it('sweating when waiting or blocked at the boundary', () => {
    const ms = cfg.sweatAfterSec * 1000;
    for (const status of ['waiting', 'blocked'] as const) {
      expect(strainFor({ ...calm, status, updatedAt: NOW - ms + 1 }, NOW, cfg, false)).toBeNull();
      expect(strainFor({ ...calm, status, updatedAt: NOW - ms }, NOW, cfg, false)).toBe('sweating');
    }
    expect(strainFor({ ...calm, status: 'active', updatedAt: 0 }, NOW, cfg, false)).toBeNull();
  });
  it('tired when active and busy at the boundary', () => {
    const ms = cfg.tiredAfterSec * 1000;
    expect(strainFor({ ...calm, startedAt: NOW - ms + 1 }, NOW, cfg, false)).toBeNull();
    expect(strainFor({ ...calm, startedAt: NOW - ms }, NOW, cfg, false)).toBe('tired');
    expect(strainFor({ ...calm, startedAt: 0, activity: 'idle' }, NOW, cfg, false)).toBeNull();
    expect(strainFor({ ...calm, startedAt: 0, status: 'waiting' }, NOW, cfg, false)).toBeNull();
  });
  it('on-a-roll needs the flag and an active agent', () => {
    expect(strainFor(calm, NOW, cfg, true)).toBe('on-a-roll');
    expect(strainFor({ ...calm, status: 'waiting' }, NOW, cfg, true)).toBeNull();
  });
  it('priority: dizzy > sweating > tired > on-a-roll', () => {
    const all: StrainInput = { ...calm, startedAt: 0, toolStartedAt: 0, updatedAt: 0 };
    expect(strainFor(all, NOW, cfg, true)).toBe('dizzy');
    expect(strainFor({ ...all, toolStartedAt: undefined }, NOW, cfg, true)).toBe('tired');
    expect(strainFor({ ...all, toolStartedAt: undefined, status: 'blocked' }, NOW, cfg, true)).toBe('sweating');
    expect(STRAIN_PRIORITY[0]).toBe('dizzy');
  });
});

describe('seeded pickers', () => {
  it('rng is deterministic and in [0,1)', () => {
    const a = dramaRng('x');
    const b = dramaRng('x');
    for (let i = 0; i < 20; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it('bucket floors by idleChatSec', () => {
    expect(dramaBucket(44_999, 45)).toBe(0);
    expect(dramaBucket(45_000, 45)).toBe(1);
  });
  it('delay stays within 0.5..1.5 x idleChatSec and is deterministic', () => {
    for (let b = 0; b < 200; b++) {
      const d = nextDramaDelayMs('floor', b, 45);
      expect(d).toBeGreaterThanOrEqual(22_500);
      expect(d).toBeLessThanOrEqual(67_500);
      expect(d).toBe(nextDramaDelayMs('floor', b, 45));
    }
  });

  const cands: DramaCandidate[] = [
    { key: 'a', roomId: 'r1', x: 0, y: 0 },
    { key: 'b', roomId: 'r1', x: 9, y: 9 },
    { key: 'c', roomId: 'r1', x: 1, y: 0 },
    { key: 'd', roomId: 'r2', x: 5, y: 5 },
    { key: 'e', roomId: 'r3', x: 2, y: 2 },
  ];
  it('pickCast is order independent and skips busy rooms', () => {
    for (let i = 0; i < 40; i++) {
      const seed = `s${i}`;
      const one = pickCast(cands, new Set(), seed);
      expect(pickCast([...cands].reverse(), new Set(), seed)).toEqual(one);
      expect(pickCast(cands, new Set(['r1', 'r2']), seed)?.roomId).toBe('r3');
    }
    expect(pickCast(cands, new Set(['r1', 'r2', 'r3']), 's')).toBeNull();
    expect(pickCast([], new Set(), 's')).toBeNull();
  });
  it('pickCast pairs the two closest and mixes solo and pair', () => {
    let pairs = 0;
    for (let i = 0; i < 200; i++) {
      const c = pickCast(cands.filter((x) => x.roomId === 'r1'), new Set(), `p${i}`)!;
      if (c.keys.length === 2) {
        pairs++;
        expect(c.keys).toEqual(['a', 'c']);
      }
    }
    expect(pairs).toBeGreaterThan(100);
    expect(pairs).toBeLessThan(180);
    // one candidate: always a solo
    expect(pickCast([cands[3]!], new Set(), 'q')).toEqual({ roomId: 'r2', keys: ['d'] });
  });

  const content: DramaContent = {
    antics: [
      { id: 'one', props: ['fridge'], cast: 1, lines: [['x']] },
      { id: 'two', props: [], cast: 2, lines: [['a', 'b'], ['c', 'd']] },
      { id: 'three', props: ['table', 'sofa'], cast: 2, lines: [['e', 'f']] },
    ],
    strain: { ...EMPTY_DRAMA.strain, tired: ['yawn', 'zzz'] },
  };
  it('pickAntic respects cast size and props', () => {
    const none = new Set<FurnitureKind>();
    for (let i = 0; i < 40; i++) {
      expect(pickAntic(content, none, 1, `a${i}`)).toBeNull();
      expect(pickAntic(content, none, 2, `a${i}`)?.id).toBe('two');
      expect(pickAntic(content, new Set<FurnitureKind>(['fridge']), 1, `a${i}`)?.id).toBe('one');
      expect(['two', 'three']).toContain(pickAntic(content, new Set<FurnitureKind>(['sofa']), 2, `a${i}`)?.id);
    }
    expect(pickAntic(content, none, 2, 'k')).toEqual(pickAntic({ ...content, antics: [...content.antics].reverse() }, none, 2, 'k'));
  });
  it('pickExchange and strainLine are deterministic members', () => {
    const two = content.antics[1]!;
    for (let i = 0; i < 20; i++) {
      expect(two.lines).toContainEqual(pickExchange(two, `e${i}`));
      expect(pickExchange(two, `e${i}`)).toEqual(pickExchange(two, `e${i}`));
    }
    expect(strainLine(content, 'tired', 'x')).toMatch(/yawn|zzz/);
    expect(strainLine(content, 'dizzy', 'x')).toBeNull();
    expect(pickExchange({ id: 'z', props: [], cast: 1, lines: [] }, 's')).toEqual(['']);
  });
  it('dramaFor falls back to EMPTY_DRAMA', () => {
    expect(dramaFor({})).toBe(EMPTY_DRAMA);
    expect(dramaFor(modernTheme)).toBe(modernTheme.drama);
  });
});

describe('StreakTracker', () => {
  const sc = { streakTools: 8, streakWindowSec: 60 };
  it('detects a rise within the window', () => {
    const t = new StreakTracker();
    t.observe('a', 0, 0);
    t.observe('a', 4, 20_000);
    expect(t.isOnARoll('a', 20_000, sc)).toBe(false);
    t.observe('a', 8, 40_000);
    expect(t.isOnARoll('a', 40_000, sc)).toBe(true);
  });
  it('counts exactly streakTools tools in the window (baseline is the sample at or before the window start)', () => {
    const t = new StreakTracker();
    t.observe('a', 0, 0);
    t.observe('a', 1, 10_000);
    t.observe('a', 9, 60_000);
    // window starts at 0: the baseline is the sample at 0 (count 0), so 9 >= 8
    expect(t.isOnARoll('a', 60_000, sc)).toBe(true);
    const u = new StreakTracker();
    u.observe('a', 5, 0);
    u.observe('a', 13, 30_000);
    expect(u.isOnARoll('a', 30_000, sc)).toBe(true);
    u.observe('a', 12, 40_000);
    expect(u.isOnARoll('a', 40_000, sc)).toBe(false);
  });
  it('a burst of 8 inside the window registers on the 8th tool, not the 9th', () => {
    const t = new StreakTracker();
    t.observe('a', 20, 0);
    t.observe('a', 22, 30_000);
    t.observe('a', 28, 80_000);
    // window [20_000, 80_000]: baseline = last sample at or before 20_000 (count 20); 28 - 20 = 8
    expect(t.isOnARoll('a', 80_000, sc)).toBe(true);
  });
  it('shared helpers feed and read one tracker', () => {
    resetStreaks();
    observeAgents([{ id: 'x', toolCount: 0 }], 0);
    observeAgents([{ id: 'x', toolCount: 8 }], 5000);
    expect(isAgentOnARoll('x', 5000, sc)).toBe(true);
    expect(isAgentOnARoll('y', 5000, sc)).toBe(false);
    resetStreaks();
    expect(isAgentOnARoll('x', 5000, sc)).toBe(false);
  });
  it('forgets the burst once the window passes', () => {
    const t = new StreakTracker();
    t.observe('a', 0, 0);
    t.observe('a', 9, 10_000);
    expect(t.isOnARoll('a', 10_000, sc)).toBe(true);
    expect(t.isOnARoll('a', 100_000, sc)).toBe(false);
  });
  it('resets on a toolCount drop and on forget', () => {
    const t = new StreakTracker();
    t.observe('a', 0, 0);
    t.observe('a', 9, 1000);
    t.observe('a', 2, 2000);
    expect(t.isOnARoll('a', 2000, sc)).toBe(false);
    t.observe('a', 10, 3000);
    expect(t.isOnARoll('a', 3000, sc)).toBe(true);
    t.forget('a');
    expect(t.isOnARoll('a', 3000, sc)).toBe(false);
    expect(t.isOnARoll('nobody', 0, sc)).toBe(false);
  });
});

// Whole word match; the content must stay pronoun-free (charming, short, no "my"/"you").
const PRONOUN = /\b(i|me|my|mine|you|your|yours|we|us|our|he|she|him|her|his|they|them|their|it|its)\b/i;

describe.each([['modern', modernTheme], ['guild', guildTheme]] as const)('%s drama content', (_name, theme) => {
  const d = theme.drama!;
  it('has >= 12 antics with both cast sizes and unique ids', () => {
    expect(d.antics.length).toBeGreaterThanOrEqual(12);
    expect(new Set(d.antics.map((a) => a.id)).size).toBe(d.antics.length);
    expect(d.antics.some((a) => a.cast === 1)).toBe(true);
    expect(d.antics.some((a) => a.cast === 2)).toBe(true);
  });
  it('has well-formed short pronoun-free lines', () => {
    for (const a of d.antics) {
      expect(a.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(a.lines.length).toBeGreaterThan(0);
      for (const ex of a.lines) {
        expect(ex.length).toBe(a.cast);
        for (const l of ex) {
          expect(l.length).toBeGreaterThan(0);
          expect(l.length, l).toBeLessThanOrEqual(48);
          expect(l, l).not.toMatch(PRONOUN);
        }
      }
    }
  });
  it('has 3 pronoun-free strain lines per kind', () => {
    for (const k of STRAIN_PRIORITY) {
      expect(d.strain[k]).toHaveLength(3);
      for (const l of d.strain[k]) {
        expect(l.length, l).toBeLessThanOrEqual(48);
        expect(l, l).not.toMatch(PRONOUN);
      }
    }
  });
  it('every antic can run in some room (a pair and a solo exist for common props)', () => {
    const all = new Set<FurnitureKind>(d.antics.flatMap((a) => a.props));
    expect(pickAntic(d, all, 1, 's')).not.toBeNull();
    expect(pickAntic(d, all, 2, 's')).not.toBeNull();
    expect(pickAntic(d, new Set(), 1, 's')).not.toBeNull();
    expect(pickAntic(d, new Set(), 2, 's')).not.toBeNull();
  });
});

describe('rift drama', () => {
  it('reuses the guild object', () => expect(riftTheme.drama).toBe(guildTheme.drama));
});
