import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run, RunEventEnvelope } from '@tagconn/shared';

// Same hoisting pattern as `authStore.test.ts`: the mock factories run before this file's own
// top-level consts, so anything they close over has to be created inside `vi.hoisted`.
const { emitWithAckMock } = vi.hoisted(() => ({ emitWithAckMock: vi.fn() }));
vi.mock('../lib/socket', () => ({
  getSocket: () => ({ on: vi.fn() }),
  emitWithAck: emitWithAckMock,
}));

const demoState = vi.hoisted(() => ({ demo: false }));
vi.mock('../lib/connection', () => ({ isDemo: () => demoState.demo }));

import { getRun, MAX_EVENTS_PER_RUN, reducers, useRunsStore } from './runsStore';

const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  kind: 'quest',
  projectId: 'proj-a',
  threadId: id,
  status: 'queued',
  prompt: 'do the thing',
  permissionMode: 'acceptEdits',
  model: 'sonnet',
  createdBy: 'admin-1',
  createdAt: 1,
  eventCount: 0,
  truncated: false,
  ...over,
});

const event = (runId: string, seq: number, over: Partial<RunEventEnvelope['event']> = {}): RunEventEnvelope => ({
  runId,
  seq,
  ts: seq,
  event: { kind: 'notice', level: 'info', message: `n${seq}`, ...over } as RunEventEnvelope['event'],
});

beforeEach(() => {
  demoState.demo = false;
  emitWithAckMock.mockReset();
  useRunsStore.setState({ runs: {}, eventsByRun: {}, runnerStatus: null, runsLoaded: false, detailLoading: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runsStore reducers (pure)', () => {
  it('upsertRun inserts and replaces by id', () => {
    let s = reducers.upsertRun({ runs: {} }, run('r1', { status: 'queued' }));
    expect(s.runs?.r1?.status).toBe('queued');
    s = reducers.upsertRun({ runs: s.runs! }, run('r1', { status: 'running' }));
    expect(s.runs?.r1?.status).toBe('running');
    expect(Object.keys(s.runs!)).toEqual(['r1']);
  });

  it('setRuns replaces the whole map, indexed by id', () => {
    const s = reducers.setRuns({ runs: { stale: run('stale') } }, [run('a'), run('b')]);
    expect(Object.keys(s.runs!).sort()).toEqual(['a', 'b']);
  });

  it('applyEvent appends new events in seq order', () => {
    let s = reducers.applyEvent({ eventsByRun: {} }, event('r1', 1));
    s = reducers.applyEvent({ eventsByRun: s.eventsByRun! }, event('r1', 2));
    expect(s.eventsByRun!.r1!.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('applyEvent dedupes by (runId, seq) — a replayed or duplicate push is a no-op', () => {
    let s = reducers.applyEvent({ eventsByRun: {} }, event('r1', 1));
    const beforeLen = s.eventsByRun!.r1!.length;
    const changed = reducers.applyEvent({ eventsByRun: s.eventsByRun! }, event('r1', 1));
    expect(changed).toEqual({}); // no update at all when nothing changed
    s = { ...s, eventsByRun: { ...s.eventsByRun!, ...changed.eventsByRun } };
    expect(s.eventsByRun!.r1!.length).toBe(beforeLen);
  });

  it('applyEvent sorts an out-of-order replay back into seq order', () => {
    let s = reducers.applyEvent({ eventsByRun: {} }, event('r1', 3));
    s = reducers.applyEvent({ eventsByRun: s.eventsByRun! }, event('r1', 1));
    s = reducers.applyEvent({ eventsByRun: s.eventsByRun! }, event('r1', 2));
    expect(s.eventsByRun!.r1!.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('applyEvent caps the per-run transcript at MAX_EVENTS_PER_RUN, dropping the oldest first', () => {
    let s: { eventsByRun: Record<string, RunEventEnvelope[]> } = { eventsByRun: {} };
    for (let i = 1; i <= MAX_EVENTS_PER_RUN + 5; i++) {
      s = { eventsByRun: { ...s.eventsByRun, ...reducers.applyEvent(s, event('r1', i)).eventsByRun } };
    }
    const kept = s.eventsByRun.r1!;
    expect(kept.length).toBe(MAX_EVENTS_PER_RUN);
    expect(kept[0]!.seq).toBe(6); // the first 5 were dropped
    expect(kept[kept.length - 1]!.seq).toBe(MAX_EVENTS_PER_RUN + 5);
  });

  it('setDetail seeds both the run and its (sorted, capped) events', () => {
    const s = reducers.setDetail(
      { runs: {}, eventsByRun: {} },
      { run: run('r1', { status: 'succeeded' }), events: [event('r1', 2), event('r1', 1)] },
    );
    expect(s.runs!.r1!.status).toBe('succeeded');
    expect(s.eventsByRun!.r1!.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('runsStore actions (live mode, mocked emitWithAck)', () => {
  it('refresh() populates runs from runs:list and marks runsLoaded', async () => {
    emitWithAckMock.mockResolvedValueOnce([run('a'), run('b')]);
    await useRunsStore.getState().refresh();
    expect(emitWithAckMock).toHaveBeenCalledWith('runs:list', {});
    expect(Object.keys(useRunsStore.getState().runs).sort()).toEqual(['a', 'b']);
    expect(useRunsStore.getState().runsLoaded).toBe(true);
  });

  it('refresh() swallows a transport error and keeps the last known runs', async () => {
    useRunsStore.setState({ runs: { a: run('a') } });
    emitWithAckMock.mockRejectedValueOnce(new Error('offline'));
    await useRunsStore.getState().refresh();
    expect(Object.keys(useRunsStore.getState().runs)).toEqual(['a']);
  });

  it('start() acks runs:start and upserts the returned run', async () => {
    const started = run('r1', { status: 'dispatched' });
    emitWithAckMock.mockResolvedValueOnce(started);
    const result = await useRunsStore.getState().start({ projectId: 'proj-a', prompt: 'hi' });
    expect(result).toEqual(started);
    expect(getRun(useRunsStore.getState().runs, 'r1')).toEqual(started);
  });

  it('stop() acks runs:stop and upserts the returned run', async () => {
    useRunsStore.setState({ runs: { r1: run('r1', { status: 'running' }) } });
    const stopped = run('r1', { status: 'stopped', endReason: 'stopped_by_user' });
    emitWithAckMock.mockResolvedValueOnce(stopped);
    await useRunsStore.getState().stop('r1');
    expect(getRun(useRunsStore.getState().runs, 'r1')?.status).toBe('stopped');
  });
});

describe('runsStore actions (demo mode)', () => {
  beforeEach(() => {
    demoState.demo = true;
    vi.useFakeTimers();
  });

  it('refreshRunnerStatus() returns a canned connected status with no network call', async () => {
    await useRunsStore.getState().refreshRunnerStatus();
    expect(emitWithAckMock).not.toHaveBeenCalled();
    const status = useRunsStore.getState().runnerStatus;
    expect(status?.connected).toBe(true);
    expect(status?.capabilities?.systemdScope).toBe(true);
  });

  it('start() creates a queued run immediately and plays it to succeeded over time', async () => {
    const created = await useRunsStore.getState().start({ projectId: 'proj-a', prompt: 'demo quest' });
    expect(created.status).toBe('queued');
    expect(getRun(useRunsStore.getState().runs, created.id)?.status).toBe('queued');

    await vi.advanceTimersByTimeAsync(3000);

    const finished = getRun(useRunsStore.getState().runs, created.id);
    expect(finished?.status).toBe('succeeded');
    expect(finished?.result?.subtype).toBe('success');
    const events = useRunsStore.getState().eventsByRun[created.id] ?? [];
    expect(events.some((e) => e.event.kind === 'init')).toBe(true);
    expect(events.some((e) => e.event.kind === 'result')).toBe(true);
  });

  it('stop() on an unknown demo run rejects instead of crashing', async () => {
    await expect(useRunsStore.getState().stop('nope')).rejects.toThrow();
  });
});
