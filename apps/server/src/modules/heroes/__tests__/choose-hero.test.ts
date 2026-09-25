import { type BoundAgentState, chooseHeroForAgent, type Hero, MAIN_ROLE, pickHeroName } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';

/** Minimal hero stub for `chooseHeroForAgent`'s `heroes` input. */
type HeroStub = Pick<Hero, 'id' | 'projectId' | 'role' | 'slot' | 'boundAgentId' | 'releasedAt'>;
const hero = (over: Partial<HeroStub> & Pick<HeroStub, 'id' | 'slot'>): HeroStub => ({
  projectId: 'p1',
  role: 'developer',
  boundAgentId: null,
  releasedAt: null,
  ...over,
});

const NOW = 1_000_000;
const baseInput = {
  agent: { id: 'agent-x', projectId: 'p1', isMain: false, role: 'developer' },
  heroes: [] as HeroStub[],
  agents: new Map<string, BoundAgentState>(),
  maxPerRole: 6,
  maxPerProject: 40,
  reuseIdleAfterSec: 600,
  now: NOW,
};

describe('chooseHeroForAgent (docs/design/living-office.md §3.2)', () => {
  it('keep: an agent already bound to a hero of its role keeps it', () => {
    const heroes = [hero({ id: 'h1', slot: 0, boundAgentId: 'agent-x' }), hero({ id: 'h2', slot: 1 })];
    const result = chooseHeroForAgent({ ...baseInput, heroes });
    expect(result).toEqual({ kind: 'keep', heroId: 'h1' });
  });

  it('keep-after-release: a hero released (its agent finished) but never taken by anyone else is kept by the same agent id', () => {
    const heroes = [hero({ id: 'h1', slot: 0, boundAgentId: 'agent-x', releasedAt: NOW - 1000 })];
    const result = chooseHeroForAgent({ ...baseInput, heroes });
    expect(result).toEqual({ kind: 'keep', heroId: 'h1' });
  });

  it('reuse order: prefers the most recently released hero, then the lowest slot', () => {
    const heroes = [
      hero({ id: 'oldest', slot: 0, boundAgentId: 'gone-1', releasedAt: 100 }),
      hero({ id: 'newest', slot: 2, boundAgentId: 'gone-2', releasedAt: 300 }),
      hero({ id: 'middle', slot: 1, boundAgentId: 'gone-3', releasedAt: 200 }),
    ];
    const result = chooseHeroForAgent({ ...baseInput, heroes });
    expect(result).toEqual({ kind: 'reuse', heroId: 'newest', takenFrom: null });
  });

  it('reuse order: never-bound heroes (boundAgentId null) are free too, tie-broken by lowest slot', () => {
    const heroes = [hero({ id: 'h-slot-1', slot: 1 }), hero({ id: 'h-slot-0', slot: 0 })];
    const result = chooseHeroForAgent({ ...baseInput, heroes });
    expect(result).toEqual({ kind: 'reuse', heroId: 'h-slot-0', takenFrom: null });
  });

  it('a hero bound to an agent the state map reports as gone (no entry) is free to reuse', () => {
    const heroes = [hero({ id: 'h1', slot: 0, boundAgentId: 'vanished-agent' })];
    const result = chooseHeroForAgent({ ...baseInput, heroes });
    expect(result).toEqual({ kind: 'reuse', heroId: 'h1', takenFrom: null });
  });

  it('GM slot 0: a main agent prefers the free slot-0 hero over a more recently released higher slot', () => {
    const heroes = [
      hero({ id: 'slot-0', slot: 0, role: MAIN_ROLE, boundAgentId: 'gone-1', releasedAt: 100 }),
      hero({ id: 'slot-1', slot: 1, role: MAIN_ROLE, boundAgentId: 'gone-2', releasedAt: 500 }),
    ];
    const result = chooseHeroForAgent({
      ...baseInput,
      agent: { id: 'main:new-session', projectId: 'p1', isMain: true, role: MAIN_ROLE },
      heroes,
    });
    expect(result).toEqual({ kind: 'reuse', heroId: 'slot-0', takenFrom: null });
  });

  it('takeover cutoff: a subagent may take over a live hero only once it has been idle at least reuseIdleAfterSec', () => {
    const heroes = [hero({ id: 'h1', slot: 0, boundAgentId: 'live-idle-agent' })];
    const agents = new Map<string, BoundAgentState>([
      ['live-idle-agent', { live: true, activity: 'idle', lastEventAt: NOW - 600_000 }],
    ]);

    // Exactly at the cutoff (600s): eligible.
    expect(chooseHeroForAgent({ ...baseInput, heroes, agents, reuseIdleAfterSec: 600 })).toEqual({
      kind: 'reuse',
      heroId: 'h1',
      takenFrom: 'live-idle-agent',
    });

    // Not idle long enough yet: falls through to create.
    const notYet = chooseHeroForAgent({ ...baseInput, heroes, agents, reuseIdleAfterSec: 900 });
    expect(notYet).toEqual({ kind: 'create', slot: 1 });
  });

  it('takeover: not idle (still active) is never taken over even past reuseIdleAfterSec', () => {
    const heroes = [hero({ id: 'h1', slot: 0, boundAgentId: 'live-busy-agent' })];
    const agents = new Map<string, BoundAgentState>([
      ['live-busy-agent', { live: true, activity: 'typing', lastEventAt: NOW - 10_000_000 }],
    ]);
    expect(chooseHeroForAgent({ ...baseInput, heroes, agents })).toEqual({ kind: 'create', slot: 1 });
  });

  it('takeover: reuseIdleAfterSec 0 disables takeover entirely', () => {
    const heroes = [hero({ id: 'h1', slot: 0, boundAgentId: 'live-idle-agent' })];
    const agents = new Map<string, BoundAgentState>([
      ['live-idle-agent', { live: true, activity: 'idle', lastEventAt: 0 }],
    ]);
    expect(chooseHeroForAgent({ ...baseInput, heroes, agents, reuseIdleAfterSec: 0 })).toEqual({ kind: 'create', slot: 1 });
  });

  it('takeover: a main agent never takes over an idle hero (main agents skip the takeover branch)', () => {
    const heroes = [hero({ id: 'h1', slot: 0, role: MAIN_ROLE, boundAgentId: 'idle-main' })];
    const agents = new Map<string, BoundAgentState>([['idle-main', { live: true, activity: 'idle', lastEventAt: 0 }]]);
    const result = chooseHeroForAgent({
      ...baseInput,
      agent: { id: 'main:new', projectId: 'p1', isMain: true, role: MAIN_ROLE },
      heroes,
      agents,
      reuseIdleAfterSec: 1,
    });
    expect(result).toEqual({ kind: 'create', slot: 1 });
  });

  it('caps: role-full stops creation once maxPerRole is reached, even with free slots elsewhere', () => {
    const heroes = [
      hero({ id: 'h1', slot: 0, boundAgentId: 'live-1' }),
      hero({ id: 'h2', slot: 1, boundAgentId: 'live-2' }),
    ];
    const agents = new Map<string, BoundAgentState>([
      ['live-1', { live: true, activity: 'typing', lastEventAt: NOW }],
      ['live-2', { live: true, activity: 'typing', lastEventAt: NOW }],
    ]);
    const result = chooseHeroForAgent({ ...baseInput, heroes, agents, maxPerRole: 2 });
    expect(result).toEqual({ kind: 'none', reason: 'role-full' });
  });

  it('caps: project-full stops creation once maxPerProject is reached, even under maxPerRole', () => {
    const heroes = [hero({ id: 'h1', slot: 0, role: 'analyst', boundAgentId: 'live-1' })];
    const agents = new Map<string, BoundAgentState>([['live-1', { live: true, activity: 'typing', lastEventAt: NOW }]]);
    const result = chooseHeroForAgent({ ...baseInput, heroes, agents, maxPerProject: 1 });
    expect(result).toEqual({ kind: 'none', reason: 'project-full' });
  });

  it('slot gaps: creation fills the lowest unused slot, not just the next number', () => {
    const heroes = [
      hero({ id: 'h0', slot: 0, boundAgentId: 'live-1' }),
      hero({ id: 'h2', slot: 2, boundAgentId: 'live-2' }),
    ];
    const agents = new Map<string, BoundAgentState>([
      ['live-1', { live: true, activity: 'typing', lastEventAt: NOW }],
      ['live-2', { live: true, activity: 'typing', lastEventAt: NOW }],
    ]);
    const result = chooseHeroForAgent({ ...baseInput, heroes, agents, maxPerRole: 6 });
    expect(result).toEqual({ kind: 'create', slot: 1 });
  });

  it('create: an empty role starts at slot 0', () => {
    expect(chooseHeroForAgent(baseInput)).toEqual({ kind: 'create', slot: 0 });
  });

  it('heroes of another project are ignored entirely', () => {
    const heroes = [hero({ id: 'other-project', slot: 0, projectId: 'p2' })];
    expect(chooseHeroForAgent({ ...baseInput, heroes, maxPerRole: 1 })).toEqual({ kind: 'create', slot: 0 });
  });
});

describe('pickHeroName (docs/design/living-office.md §3.1)', () => {
  const pool = ['Aldric', 'Seraphine', 'Magnus'];

  it('pool order: picks starting from the seeded index, wrapping around', () => {
    expect(pickHeroName(pool, [], 0, 'Hero')).toBe('Aldric');
    expect(pickHeroName(pool, [], 1, 'Hero')).toBe('Seraphine');
    expect(pickHeroName(pool, [], 3, 'Hero')).toBe('Aldric'); // wraps: 3 % 3 === 0
  });

  it('case-insensitivity: a taken name blocks its pool entry regardless of case', () => {
    expect(pickHeroName(pool, ['ALDRIC'], 0, 'Hero')).toBe('Seraphine');
    expect(pickHeroName(pool, ['aldric', 'seraphine', 'magnus'], 0, 'Hero')).toBe('Aldric II');
  });

  it('roman suffixes: once the whole pool is taken, walks "<name> II", "<name> III", … before falling back', () => {
    // Every base name is taken, and every "<name> II" is taken too, so it must reach the "III" suffix
    // (still walking the pool from the seeded start index at each suffix level) before finding a free one.
    const taken = [...pool, 'Aldric II', 'Seraphine II', 'Magnus II'];
    expect(pickHeroName(pool, taken, 0, 'Hero')).toBe('Aldric III');
  });

  it('fallback: an entirely empty pool falls back to "<fallbackBase> N"', () => {
    expect(pickHeroName([], [], 0, 'Developer')).toBe('Developer 1');
    expect(pickHeroName([], ['Developer 1', 'Developer 2'], 0, 'Developer')).toBe('Developer 3');
  });

  it('fallback: an empty fallbackBase still produces a usable name ("Hero N")', () => {
    expect(pickHeroName([], [], 0, '   ')).toBe('Hero 1');
  });

  it('the 40-character clip: a name longer than HERO_LIMITS.maxNameLength is clipped before use', () => {
    const long = 'A'.repeat(60);
    const name = pickHeroName([long], [], 0, 'Hero');
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).toBe('A'.repeat(40));
  });

  it('the 40-character clip: a roman-suffixed name stays within the length cap', () => {
    const long = 'B'.repeat(40);
    const name = pickHeroName([long], [long], 0, 'Hero');
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.endsWith(' II')).toBe(true);
  });
});
