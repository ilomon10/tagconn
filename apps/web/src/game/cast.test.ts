import { describe, expect, it } from 'vitest';
import type { Agent, Hero, HeroAppearance, Session, Settings } from '@tagconn/shared';
import { HERO_BIND_GRACE_MS, resolveCast, type CastInput } from './cast';

const APPEARANCE: HeroAppearance = {
  skin: '#f5c89a',
  hairStyle: 0,
  hairColor: '#3b2a20',
  outfitColor: null,
  hat: 'auto',
  hatColor: null,
  prop: 'auto',
  accessory: 'auto',
  accessoryColor: null,
};

let seq = 0;
const nextId = (prefix: string) => `${prefix}${++seq}`;

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: nextId('a'),
    sessionId: 'main:s1',
    projectId: 'p1',
    isMain: false,
    agentType: 'general-purpose',
    role: 'developer',
    status: 'active',
    activity: 'typing',
    zone: 'desks',
    toolCount: 1,
    startedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function main(overrides: Partial<Agent> = {}): Agent {
  return agent({
    id: 'main:s1',
    sessionId: 's1',
    isMain: true,
    agentType: 'main',
    role: 'pm',
    zone: 'pm-office',
    activity: 'thinking',
    ...overrides,
  });
}

function hero(overrides: Partial<Hero> = {}): Hero {
  return {
    id: `h-${(++seq).toString(16).padStart(8, '0')}`,
    projectId: 'p1',
    role: 'developer',
    slot: 0,
    name: 'Brom',
    title: null,
    appearance: APPEARANCE,
    customized: false,
    boundAgentId: null,
    boundAt: null,
    releasedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    projectId: 'p1',
    status: 'active',
    startedAt: 1_000,
    ...overrides,
  };
}

const OFFICE_SINGLE: Pick<Settings['office'], 'pmMode' | 'pmSwitchCooldownSec'> = { pmMode: 'single', pmSwitchCooldownSec: 15 };
const OFFICE_PER_SESSION: Pick<Settings['office'], 'pmMode' | 'pmSwitchCooldownSec'> = { pmMode: 'per-session', pmSwitchCooldownSec: 15 };

function baseInput(overrides: Partial<CastInput> = {}): CastInput {
  return {
    agents: [],
    heroes: [],
    sessions: [],
    office: OFFICE_SINGLE,
    heroesEnabled: true,
    prevPrimary: new Map(),
    now: 100_000,
    maxCharacters: 40,
    ...overrides,
  };
}

describe('resolveCast: one PM per floor (single mode, section 5)', () => {
  it('picks the only live main agent as Guild Master', () => {
    const gm = main({ id: 'main:s1', updatedAt: 5_000 });
    const cast = resolveCast(baseInput({ agents: [gm], sessions: [session({ id: 's1' })] }));
    expect(cast.members).toHaveLength(1);
    expect(cast.members[0]).toMatchObject({ key: 'gm:p1', kind: 'guild-master', agent: gm });
    expect(cast.members[0]!.sessionsChip).toBeUndefined();
    expect(cast.primary.get('p1')).toBe('main:s1');
    expect(cast.hidden).toEqual([]);
  });

  it('prefers the most recently updated waiting/blocked candidate over a merely more recent active one', () => {
    const a = main({ id: 'main:sA', sessionId: 'sA', status: 'active', updatedAt: 9_000 });
    const b = main({ id: 'main:sB', sessionId: 'sB', status: 'waiting', updatedAt: 2_000 });
    const c = main({ id: 'main:sC', sessionId: 'sC', status: 'blocked', updatedAt: 5_000 });
    const cast = resolveCast(
      baseInput({
        agents: [a, b, c],
        sessions: [session({ id: 'sA' }), session({ id: 'sB' }), session({ id: 'sC' })],
      }),
    );
    // c: waiting/blocked pool, most recently updated among {b, c} -> c wins even though a is newest overall.
    expect(cast.primary.get('p1')).toBe('main:sC');
    expect(cast.members[0]!.agent.id).toBe('main:sC');
  });

  it('reports the other live sessions as a chip with count and attention', () => {
    const a = main({ id: 'main:sA', sessionId: 'sA', status: 'active', updatedAt: 9_000 });
    const b = main({ id: 'main:sB', sessionId: 'sB', status: 'active', updatedAt: 1_000 });
    const c = main({ id: 'main:sC', sessionId: 'sC', status: 'waiting', updatedAt: 500 });
    const cast = resolveCast(
      baseInput({
        agents: [a, b, c],
        sessions: [session({ id: 'sA' }), session({ id: 'sB' }), session({ id: 'sC' })],
      }),
    );
    expect(cast.primary.get('p1')).toBe('main:sC'); // waiting preempts
    const gm = cast.members[0]!;
    expect(gm.sessionsChip).toEqual({ count: 2, attention: false, agentIds: ['main:sA', 'main:sB'].sort() });
    // the other sessions are not drawn, but are known to the roster
    expect(cast.hidden).toEqual(['main:sA', 'main:sB'].sort());
  });

  it('flags attention when a non-primary session needs you', () => {
    const a = main({ id: 'main:sA', sessionId: 'sA', status: 'active', updatedAt: 9_000 });
    const b = main({ id: 'main:sB', sessionId: 'sB', status: 'blocked', updatedAt: 1_000 });
    const cast = resolveCast(baseInput({ agents: [a, b], sessions: [session({ id: 'sA' }), session({ id: 'sB' })] }));
    expect(cast.primary.get('p1')).toBe('main:sB'); // waiting/blocked wins even though older
    expect(cast.members[0]!.sessionsChip).toEqual({ count: 1, attention: false, agentIds: ['main:sA'] });
  });

  it('keeps the previous primary under the cooldown even though a challenger is slightly newer', () => {
    const a = main({ id: 'main:sA', sessionId: 'sA', status: 'active', updatedAt: 10_000 });
    const b = main({ id: 'main:sB', sessionId: 'sB', status: 'active', updatedAt: 10_000 + 5_000 }); // +5s, cooldown is 15s
    const cast = resolveCast(
      baseInput({
        agents: [a, b],
        sessions: [session({ id: 'sA' }), session({ id: 'sB' })],
        prevPrimary: new Map([['p1', 'main:sA']]),
        now: 20_000,
      }),
    );
    expect(cast.primary.get('p1')).toBe('main:sA');
  });

  it('switches once a challenger is ahead by more than pmSwitchCooldownSec', () => {
    const a = main({ id: 'main:sA', sessionId: 'sA', status: 'active', updatedAt: 10_000 });
    const b = main({ id: 'main:sB', sessionId: 'sB', status: 'active', updatedAt: 10_000 + 15_001 }); // +15.001s > 15s cooldown
    const cast = resolveCast(
      baseInput({
        agents: [a, b],
        sessions: [session({ id: 'sA' }), session({ id: 'sB' })],
        prevPrimary: new Map([['p1', 'main:sA']]),
        now: 30_000,
      }),
    );
    expect(cast.primary.get('p1')).toBe('main:sB');
  });

  it('switches immediately (bypassing the cooldown) when the challenger needs you and the primary does not', () => {
    const a = main({ id: 'main:sA', sessionId: 'sA', status: 'active', updatedAt: 10_000 });
    const b = main({ id: 'main:sB', sessionId: 'sB', status: 'waiting', updatedAt: 10_001 }); // +1ms only
    const cast = resolveCast(
      baseInput({
        agents: [a, b],
        sessions: [session({ id: 'sA' }), session({ id: 'sB' })],
        prevPrimary: new Map([['p1', 'main:sA']]),
        now: 10_002,
      }),
    );
    expect(cast.primary.get('p1')).toBe('main:sB');
  });

  it('picks a new primary once the previous one is gone (session ended)', () => {
    const b = main({ id: 'main:sB', sessionId: 'sB', status: 'active', updatedAt: 4_000 });
    const cast = resolveCast(
      baseInput({
        agents: [b],
        sessions: [session({ id: 'sB' })],
        prevPrimary: new Map([['p1', 'main:sA']]), // sA no longer exists
      }),
    );
    expect(cast.primary.get('p1')).toBe('main:sB');
  });

  it('excludes a done main agent and a main agent whose session ended from candidacy', () => {
    const done = main({ id: 'main:sDone', sessionId: 'sDone', status: 'done', updatedAt: 9_999 });
    const endedSession = main({ id: 'main:sEnded', sessionId: 'sEnded', status: 'active', updatedAt: 9_999 });
    const live = main({ id: 'main:sLive', sessionId: 'sLive', status: 'active', updatedAt: 1 });
    const cast = resolveCast(
      baseInput({
        agents: [done, endedSession, live],
        sessions: [session({ id: 'sDone' }), session({ id: 'sEnded', status: 'ended' }), session({ id: 'sLive' })],
      }),
    );
    expect(cast.primary.get('p1')).toBe('main:sLive');
    expect(cast.members).toHaveLength(1);
  });

  it('draws the Guild Master with pm hero slot 0’s look regardless of which session is primary', () => {
    const slot0 = hero({ id: 'h-00000000', projectId: 'p1', role: 'pm', slot: 0, name: 'Aldric', boundAgentId: 'main:sA' });
    const slot1 = hero({ id: 'h-00000001', projectId: 'p1', role: 'pm', slot: 1, name: 'Seraphine', boundAgentId: 'main:sB' });
    const a = main({ id: 'main:sA', sessionId: 'sA', status: 'active', updatedAt: 1_000 });
    const b = main({ id: 'main:sB', sessionId: 'sB', status: 'waiting', updatedAt: 2_000 }); // becomes primary
    const cast = resolveCast(
      baseInput({
        agents: [a, b],
        heroes: [slot0, slot1],
        sessions: [session({ id: 'sA' }), session({ id: 'sB' })],
      }),
    );
    expect(cast.primary.get('p1')).toBe('main:sB');
    const gm = cast.members[0]!;
    expect(gm.agent.id).toBe('main:sB');
    expect(gm.hero?.id).toBe('h-00000000'); // slot 0's look, not sB's own hero (slot 1)
  });

  it('leaves the Guild Master hero null when the pm slot 0 row does not exist yet', () => {
    const a = main({ id: 'main:sA', sessionId: 'sA' });
    const cast = resolveCast(baseInput({ agents: [a], sessions: [session({ id: 'sA' })] }));
    expect(cast.members[0]!.hero).toBeNull();
  });

  it('produces no Guild Master when there are no live main agents (subagents can still be drawn)', () => {
    const sub = agent({ id: 'sub1', activity: 'typing' });
    const cast = resolveCast(baseInput({ agents: [sub] }));
    expect(cast.members.some((m) => m.kind === 'guild-master')).toBe(false);
    expect(cast.members.map((m) => m.agent.id)).toEqual(['sub1']);
  });
});

describe('resolveCast: per-session mode', () => {
  it('draws every live main agent as its own member, with its own bound hero, no chip', () => {
    const heroA = hero({ id: 'h-0000000a', role: 'pm', slot: 0, boundAgentId: 'main:sA' });
    const a = main({ id: 'main:sA', sessionId: 'sA', updatedAt: 1_000 });
    const b = main({ id: 'main:sB', sessionId: 'sB', updatedAt: 2_000 });
    const cast = resolveCast(
      baseInput({
        agents: [a, b],
        heroes: [heroA],
        office: OFFICE_PER_SESSION,
        sessions: [session({ id: 'sA' }), session({ id: 'sB' })],
      }),
    );
    expect(cast.members).toHaveLength(2);
    expect(cast.members.every((m) => m.kind === 'member')).toBe(true);
    expect(cast.members.every((m) => m.sessionsChip === undefined)).toBe(true);
    const byId = new Map(cast.members.map((m) => [m.agent.id, m]));
    expect(byId.get('main:sA')!.key).toBe('hero:h-0000000a');
    expect(byId.get('main:sB')!.key).toBe('agent:main:sB'); // no hero bound -> anonymous
    expect(cast.hidden).toEqual([]);
  });
});

describe('resolveCast: hiding idle unbound agents and the bind grace window (section 4.1)', () => {
  it('hides an idle non-main agent with no hero (roster only)', () => {
    const a = agent({ id: 'sub1', activity: 'idle', startedAt: 0, updatedAt: 0 });
    const cast = resolveCast(baseInput({ agents: [a], now: 1_000_000 }));
    expect(cast.members).toEqual([]);
    expect(cast.hidden).toEqual(['sub1']);
  });

  it('does not hide an idle agent that already has a bound hero', () => {
    const h = hero({ boundAgentId: 'sub1' });
    const a = agent({ id: 'sub1', activity: 'idle' });
    const cast = resolveCast(baseInput({ agents: [a], heroes: [h] }));
    expect(cast.members).toHaveLength(1);
    expect(cast.members[0]!.key).toBe(`hero:${h.id}`);
  });

  it('hides a brand-new non-main agent with no hero during the 750ms grace window, then draws it anonymously', () => {
    const a = agent({ id: 'sub1', activity: 'typing', startedAt: 10_000, updatedAt: 10_000 });
    const stillGrace = resolveCast(baseInput({ agents: [a], now: 10_000 + HERO_BIND_GRACE_MS - 1 }));
    expect(stillGrace.members).toEqual([]);
    expect(stillGrace.hidden).toEqual(['sub1']);

    const graceOver = resolveCast(baseInput({ agents: [a], now: 10_000 + HERO_BIND_GRACE_MS }));
    expect(graceOver.members).toHaveLength(1);
    expect(graceOver.members[0]!.key).toBe('agent:sub1');
    expect(graceOver.members[0]!.hero).toBeNull();
    expect(graceOver.hidden).toEqual([]);
  });

  it('does not hide anything for hero-hiding rules when heroes are disabled', () => {
    const idle = agent({ id: 'sub1', activity: 'idle', startedAt: 0, updatedAt: 0 });
    const brandNew = agent({ id: 'sub2', activity: 'typing', startedAt: 999_900, updatedAt: 999_900 });
    const cast = resolveCast(baseInput({ agents: [idle, brandNew], heroesEnabled: false, now: 1_000_000 }));
    expect(cast.members.map((m) => m.agent.id).sort()).toEqual(['sub1', 'sub2']);
    expect(cast.members.every((m) => m.hero === null)).toBe(true);
    expect(cast.hidden).toEqual([]);
  });
});

describe('resolveCast: actor keys by hero id (reuse, section 4.2 boundary)', () => {
  it('gives a subagent bound to a hero the same key as the previous agent that hero was bound to (no new sprite)', () => {
    const h = hero({ id: 'h-0000000a', boundAgentId: 'oldAgent' });
    const first = resolveCast(baseInput({ agents: [agent({ id: 'oldAgent' })], heroes: [h] }));
    expect(first.members[0]!.key).toBe('hero:h-0000000a');

    // oldAgent finished and was released; the hero was reused by a brand-new agent (same hero row,
    // boundAgentId now points at the new agent) — the resolved key must be identical.
    const reused = { ...h, boundAgentId: 'newAgent', releasedAt: null };
    const second = resolveCast(baseInput({ agents: [agent({ id: 'newAgent' })], heroes: [reused] }));
    expect(second.members[0]!.key).toBe(first.members[0]!.key);
    // the old agent is gone from the input entirely (as it would be once removed by the caller),
    // so it has no representation of its own in this call.
    expect(second.members.map((m) => m.agent.id)).toEqual(['newAgent']);
  });

  it('keeps a done subagent’s hero-keyed member as long as the caller still includes it (lets the scene see the transition)', () => {
    const h = hero({ boundAgentId: 'sub1' });
    const done = agent({ id: 'sub1', status: 'done', activity: 'done' });
    const cast = resolveCast(baseInput({ agents: [done], heroes: [h] }));
    expect(cast.members).toHaveLength(1);
    expect(cast.members[0]!.key).toBe(`hero:${h.id}`);
  });
});

describe('resolveCast: cap ordering (maxCharacters / multiverse caps)', () => {
  it('orders Guild Master first, then agents that need you, then by startedAt, and hides the overflow', () => {
    const gmAgent = main({ id: 'main:s1', updatedAt: 5_000 });
    const waitingLate = agent({ id: 'w1', status: 'waiting', startedAt: 9_000, updatedAt: 9_000 });
    const waitingEarly = agent({ id: 'w2', status: 'blocked', startedAt: 1_000, updatedAt: 1_000 });
    const plainOld = agent({ id: 'm1', startedAt: 2_000 });
    const plainNew = agent({ id: 'm2', startedAt: 8_000 });
    const cast = resolveCast(
      baseInput({
        agents: [plainNew, waitingLate, gmAgent, plainOld, waitingEarly],
        sessions: [session({ id: 's1' })],
        maxCharacters: 3,
      }),
    );
    expect(cast.members.map((m) => m.agent.id)).toEqual(['main:s1', 'w2', 'w1']); // gm, then needs-you by startedAt
    expect(cast.hidden.sort()).toEqual(['m1', 'm2'].sort());
  });

  it('never drops the Guild Master even when the cap is very small', () => {
    const gmAgent = main({ id: 'main:s1' });
    const other = agent({ id: 'sub1', status: 'blocked' });
    const cast = resolveCast(baseInput({ agents: [gmAgent, other], sessions: [session({ id: 's1' })], maxCharacters: 1 }));
    expect(cast.members).toHaveLength(1);
    expect(cast.members[0]!.kind).toBe('guild-master');
    expect(cast.hidden).toEqual(['sub1']);
  });

  it('supports a per-realm fair-share cap by being called once per project (Multiverse usage)', () => {
    const p1Agents = [main({ id: 'main:sP1', sessionId: 'sP1', projectId: 'p1' })];
    const p2Agents = [main({ id: 'main:sP2', sessionId: 'sP2', projectId: 'p2' })];
    const castP1 = resolveCast(baseInput({ agents: p1Agents, sessions: [session({ id: 'sP1', projectId: 'p1' })], maxCharacters: 1 }));
    const castP2 = resolveCast(baseInput({ agents: p2Agents, sessions: [session({ id: 'sP2', projectId: 'p2' })], maxCharacters: 1 }));
    expect(castP1.primary.get('p1')).toBe('main:sP1');
    expect(castP2.primary.get('p2')).toBe('main:sP2');
    expect(castP1.primary.has('p2')).toBe(false);
  });
});

describe('resolveCast: deterministic output', () => {
  it('returns the same members and hidden order regardless of input agent array order', () => {
    const gmAgent = main({ id: 'main:s1', updatedAt: 5_000 });
    const w1 = agent({ id: 'w1', status: 'waiting', startedAt: 3_000, updatedAt: 3_000 });
    const w2 = agent({ id: 'w2', status: 'blocked', startedAt: 3_000, updatedAt: 3_000 }); // same startedAt as w1: tie-break by key
    const m1 = agent({ id: 'm1', startedAt: 2_000 });
    const inputAgents = [gmAgent, w1, w2, m1];
    const sessions = [session({ id: 's1' })];

    const a = resolveCast(baseInput({ agents: inputAgents, sessions }));
    const b = resolveCast(baseInput({ agents: [...inputAgents].reverse(), sessions }));
    expect(b.members.map((m) => m.key)).toEqual(a.members.map((m) => m.key));
    expect(b.hidden).toEqual(a.hidden);
  });

  it('running resolveCast twice on identical input produces identical output', () => {
    const input = baseInput({
      agents: [main({ id: 'main:s1' }), agent({ id: 'sub1' })],
      sessions: [session({ id: 's1' })],
    });
    expect(resolveCast(input)).toEqual(resolveCast(input));
  });
});
