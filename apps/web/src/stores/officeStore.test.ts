import { beforeEach, describe, expect, it } from 'vitest';
import type { Agent, OfficeEvent, OfficeSnapshot, Project, Session, TokenUsage } from '@tagconn/shared';
import { MULTIVERSE_FLOOR_ID } from '@tagconn/shared';
import { ALL_FLOORS, MIN_EVENT_LIMIT, foldLastLiveAt, initialOfficeData, prunePins, reducers, useOfficeStore, visibleProjects, type OfficeData } from './officeStore';

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id,
  sessionId: 's1',
  projectId: 'p1',
  isMain: false,
  agentType: 'developer',
  role: 'developer',
  status: 'active',
  activity: 'typing',
  zone: 'desks',
  toolCount: 0,
  startedAt: 1,
  updatedAt: 1,
  ...over,
});

const event = (id: number, over: Partial<OfficeEvent> = {}): OfficeEvent => ({
  id,
  ts: id,
  projectId: 'p1',
  sessionId: 's1',
  agentId: 'a1',
  hookEvent: 'PreToolUse',
  summary: `e${id}`,
  ...over,
});

const apply = (s: OfficeData, patch: Partial<OfficeData>): OfficeData => ({ ...s, ...patch });

describe('office reducers', () => {
  it('applySnapshot replaces state, indexes by id and sorts events', () => {
    const snap: OfficeSnapshot = {
      projects: [{ id: 'p1', cwd: '/x', name: 'x', archived: false, createdAt: 0, lastActivityAt: 0 }],
      sessions: [{ id: 's1', projectId: 'p1', status: 'active', startedAt: 0 }],
      agents: [agent('a1'), agent('a2')],
      tasks: [{ id: 't1', projectId: 'p1', sessionId: 's1', title: 'T', status: 'todo', source: 'todo', createdAt: 0, updatedAt: 0 }],
      events: [event(3), event(1), event(2)],
    };
    let s = apply(initialOfficeData(), { agents: { stale: agent('stale') } });
    s = apply(s, reducers.applySnapshot(s, snap));
    expect(Object.keys(s.agents).sort()).toEqual(['a1', 'a2']);
    expect(s.projects.p1?.name).toBe('x');
    expect(s.tasks.t1?.status).toBe('todo');
    expect(s.events.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it('upsertAgent inserts, updates and ignores stale updates', () => {
    let s = initialOfficeData();
    s = apply(s, reducers.upsertAgent(s, agent('a1', { updatedAt: 5, activity: 'typing' })));
    s = apply(s, reducers.upsertAgent(s, agent('a1', { updatedAt: 6, activity: 'reading' })));
    expect(s.agents.a1?.activity).toBe('reading');
    s = apply(s, reducers.upsertAgent(s, agent('a1', { updatedAt: 4, activity: 'testing' })));
    expect(s.agents.a1?.activity).toBe('reading');
  });

  it('removeAgent removes and is a no-op for unknown ids', () => {
    let s = initialOfficeData();
    s = apply(s, reducers.upsertAgent(s, agent('a1')));
    expect(reducers.removeAgent(s, 'nope')).toEqual({});
    s = apply(s, reducers.removeAgent(s, 'a1'));
    expect(s.agents).toEqual({});
  });

  it('addEvent dedupes, keeps order and caps the ring buffer', () => {
    let s = apply(initialOfficeData(), { eventLimit: 60 });
    for (let i = 1; i <= 100; i++) s = apply(s, reducers.addEvent(s, event(i)));
    s = apply(s, reducers.addEvent(s, event(100)));
    expect(s.events).toHaveLength(60);
    expect(s.events[0]?.id).toBe(41);
    expect(s.events.at(-1)?.id).toBe(100);
    // out-of-order arrival is sorted in
    s = apply(s, reducers.addEvent(s, event(99.5)));
    expect(s.events.at(-2)?.id).toBe(99.5);
  });

  it('never caps below MIN_EVENT_LIMIT and setEventLimit trims', () => {
    let s = initialOfficeData();
    for (let i = 1; i <= 120; i++) s = apply(s, reducers.addEvent(s, event(i)));
    expect(s.events).toHaveLength(120);
    s = apply(s, reducers.setEventLimit(s, 0));
    expect(s.events).toHaveLength(MIN_EVENT_LIMIT);
  });

  it('prependEvents merges older pages without duplicates', () => {
    let s = initialOfficeData();
    s = apply(s, reducers.addEvent(s, event(10)));
    s = apply(s, reducers.prependEvents(s, [event(8), event(9), event(10)]));
    expect(s.events.map((e) => e.id)).toEqual([8, 9, 10]);
  });

  it('upsertAgent carries usage through inserts and updates', () => {
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 1, messages: 2, contextTokens: 16, model: 'claude-sonnet-5' };
    let s = initialOfficeData();
    s = apply(s, reducers.upsertAgent(s, agent('a1', { usage, updatedAt: 1 })));
    expect(s.agents.a1?.usage).toEqual(usage);
    const usage2: TokenUsage = { ...usage, outputTokens: 40, contextTokens: 36 };
    s = apply(s, reducers.upsertAgent(s, agent('a1', { usage: usage2, updatedAt: 2 })));
    expect(s.agents.a1?.usage).toEqual(usage2);
  });

  it('upsertProject inserts and replaces the whole project record', () => {
    const p1: Project = { id: 'p1', cwd: '/x', name: 'x', archived: false, createdAt: 0, lastActivityAt: 0 };
    let s = initialOfficeData();
    s = apply(s, reducers.upsertProject(s, p1));
    expect(s.projects.p1?.name).toBe('x');
    s = apply(s, reducers.upsertProject(s, { ...p1, name: 'renamed', archived: true }));
    expect(s.projects.p1).toEqual({ ...p1, name: 'renamed', archived: true });
  });
});

describe('ALL_FLOORS', () => {
  it('is kept as an alias of MULTIVERSE_FLOOR_ID (M8 8h, L7)', () => {
    expect(ALL_FLOORS).toBe(MULTIVERSE_FLOOR_ID);
  });
});

describe('lastLiveAt tracking (M8 8h, feeds planMultiverse)', () => {
  it('foldLastLiveAt bumps a project on a live agent, ignores done ones', () => {
    let map = foldLastLiveAt({}, [agent('a1', { projectId: 'p1', updatedAt: 10, status: 'active' })]);
    expect(map).toEqual({ p1: 10 });
    map = foldLastLiveAt(map, [agent('a2', { projectId: 'p1', updatedAt: 5, status: 'active' })]);
    expect(map.p1).toBe(10); // never rewinds
    map = foldLastLiveAt(map, [agent('a3', { projectId: 'p1', updatedAt: 20, status: 'active' })]);
    expect(map.p1).toBe(20);
    map = foldLastLiveAt(map, [agent('a4', { projectId: 'p2', updatedAt: 99, status: 'done' })]);
    expect(map.p2).toBeUndefined();
  });

  it('upsertAgent, removeAgent and applySnapshot all bump lastLiveAt for live agents', () => {
    let s = initialOfficeData();
    s = apply(s, reducers.upsertAgent(s, agent('a1', { projectId: 'p1', updatedAt: 10, status: 'active' })));
    expect(s.lastLiveAt).toEqual({ p1: 10 });

    // removeAgent still records the moment right before removal, so a project stays "recently live"
    // for the hysteresis window even after its agent is purged from the map.
    s = apply(s, reducers.removeAgent(s, 'a1'));
    expect(s.agents).toEqual({});
    expect(s.lastLiveAt).toEqual({ p1: 10 });

    const snap: OfficeSnapshot = {
      projects: [],
      sessions: [],
      agents: [agent('a2', { projectId: 'p2', updatedAt: 30, status: 'active' })],
      tasks: [],
      events: [],
    };
    s = apply(s, reducers.applySnapshot(s, snap));
    expect(s.lastLiveAt).toEqual({ p1: 10, p2: 30 });
  });
});

describe('pinnedPrimary (Guild Master pin, M8 8b)', () => {
  const session = (id: string, over: Partial<Session> = {}): Session => ({ id, projectId: 'p1', status: 'active', startedAt: 0, ...over });

  it('pinPrimary sets a pin and unpinPrimary clears it', () => {
    let s = initialOfficeData();
    s = apply(s, reducers.pinPrimary(s, 'p1', 'a1'));
    expect(s.pinnedPrimary).toEqual({ p1: 'a1' });
    expect(reducers.unpinPrimary(s, 'nope')).toEqual({}); // no-op for an unknown project
    s = apply(s, reducers.unpinPrimary(s, 'p1'));
    expect(s.pinnedPrimary).toEqual({});
  });

  it('prunePins drops a pin once its agent is gone, done, or its session has ended', () => {
    const agents = { a1: agent('a1', { sessionId: 's1', status: 'active' }) };
    const sessions = { s1: session('s1', { status: 'active' }) };
    expect(prunePins({ p1: 'a1' }, agents, sessions)).toEqual({ p1: 'a1' });
    expect(prunePins({ p1: 'a1', p2: 'gone' }, agents, sessions)).toEqual({ p1: 'a1' }); // p2's agent doesn't exist
    expect(prunePins({ p1: 'a1' }, { a1: { ...agents.a1, status: 'done' } }, sessions)).toEqual({});
    expect(prunePins({ p1: 'a1' }, agents, { s1: session('s1', { status: 'ended' }) })).toEqual({});
  });

  it('a session ending (upsertSession) auto-prunes any pin on it', () => {
    let s = initialOfficeData();
    s = apply(s, reducers.upsertAgent(s, agent('a1', { sessionId: 's1' })));
    s = apply(s, reducers.pinPrimary(s, 'p1', 'a1'));
    expect(s.pinnedPrimary).toEqual({ p1: 'a1' });
    s = apply(s, reducers.upsertSession(s, session('s1', { status: 'ended' })));
    expect(s.pinnedPrimary).toEqual({});
  });
});

describe('visibleProjects', () => {
  const active: Project = { id: 'active', cwd: '/a', name: 'active', archived: false, createdAt: 0, lastActivityAt: 2 };
  const archived: Project = { id: 'archived', cwd: '/b', name: 'archived', archived: true, createdAt: 0, lastActivityAt: 1 };
  const projects = { [active.id]: active, [archived.id]: archived };

  it('hides archived floors by default', () => {
    expect(visibleProjects(projects).map((p) => p.id)).toEqual(['active']);
  });

  it('keeps an archived floor visible if it is currently selected', () => {
    expect(visibleProjects(projects, { selectedId: 'archived' }).map((p) => p.id)).toEqual(['active', 'archived']);
  });

  it('shows every floor when showArchived is set', () => {
    expect(visibleProjects(projects, { showArchived: true }).map((p) => p.id)).toEqual(['active', 'archived']);
  });
});

describe('useOfficeStore', () => {
  beforeEach(() => useOfficeStore.setState(initialOfficeData()));

  it('wires actions to reducers', () => {
    const st = useOfficeStore.getState();
    st.upsertAgent(agent('a1'));
    st.upsertTask({ id: 't1', projectId: 'p1', sessionId: 's1', title: 'T', status: 'doing', source: 'agent-call', createdAt: 0, updatedAt: 0 });
    st.addEvent(event(1));
    st.selectProject('p1');
    st.setConnection('connected');
    st.pinPrimary('p1', 'a1');
    const s = useOfficeStore.getState();
    expect(s.agents.a1).toBeDefined();
    expect(s.tasks.t1?.status).toBe('doing');
    expect(s.events).toHaveLength(1);
    expect(s.selectedProjectId).toBe('p1');
    expect(s.pinnedPrimary).toEqual({ p1: 'a1' });
    expect(s.lastLiveAt).toEqual({ p1: 1 });
    s.unpinPrimary('p1');
    expect(useOfficeStore.getState().pinnedPrimary).toEqual({});
    s.reset();
    const r = useOfficeStore.getState();
    expect(r.agents).toEqual({});
    expect(r.selectedProjectId).toBe('p1');
    expect(r.connection).toBe('connected');
    expect(r.lastLiveAt).toEqual({});
  });
});
