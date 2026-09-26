import { create } from 'zustand';
import type { Run, RunDetail, RunEventEnvelope, RunFollowUpRequest, RunListQuery, RunStartRequest, RunnerStatus } from '@tagconn/shared';
import { isDemo } from '../lib/connection';
import { emitWithAck, getSocket } from '../lib/socket';
import { demoRunnerStatus, followUpDemoQuest, startDemoQuest, stopDemoQuest } from '../features/quests/demo';

/**
 * Quest board state (M8 8k, docs/design/runner-and-helpdesk.md section 3). Runs are keyed by id
 * (broadcast to `rooms.admin`, not scoped to the subscribed floor — same "global map, filter in the
 * UI" shape as `stores/heroStore.ts`). Events arrive one envelope at a time over `run:event` and are
 * kept per-run, deduped by `seq` and capped, so a reconnect replay or a duplicate push can't grow the
 * transcript unboundedly or double a line.
 *
 * Demo mode (`/?demo=1`) has no server or runner at all: `refresh`/`refreshRunnerStatus` short-circuit
 * to a canned status, and `start`/`followUp`/`stop` hand off to `features/quests/demo.ts`, which
 * simulates a run on a timer by calling straight back into this store's own setters — the UI code
 * never needs to know which mode it's in.
 */

/** Per-run transcript cap: generous for a browser tab, well below `settings.runner.maxEventsPerRun`
 *  (the server's own cap, already enforced before anything reaches here). Oldest events are dropped
 *  first, same as `stores/officeStore.ts`'s `capEvents`. */
export const MAX_EVENTS_PER_RUN = 2000;

function emptyRunMap(): Record<string, Run> {
  return Object.create(null) as Record<string, Run>;
}

/** Shallow-copies into a fresh null-prototype map — same hardening as `heroStore`'s `cloneHeroMap`
 *  (a run id ultimately comes off the network), belt-and-braces alongside `Object.hasOwn` below. */
function cloneRunMap(base: Record<string, Run>): Record<string, Run> {
  return Object.assign(emptyRunMap(), base);
}

export const getRun = (runs: Record<string, Run>, id: string): Run | undefined => (Object.hasOwn(runs, id) ? runs[id] : undefined);

export interface RunsData {
  runs: Record<string, Run>;
  eventsByRun: Record<string, RunEventEnvelope[]>;
  runnerStatus: RunnerStatus | null;
  runsLoaded: boolean;
  detailLoading: Record<string, boolean>;
}

const capEventEnvelopes = (events: RunEventEnvelope[]): RunEventEnvelope[] =>
  events.length > MAX_EVENTS_PER_RUN ? events.slice(events.length - MAX_EVENTS_PER_RUN) : events;

/** Pure reducers — the store below just wires them to zustand (same split as `stores/officeStore.ts`
 *  so the merge/dedupe/cap logic is unit-testable without a React render or a socket). */
export const reducers = {
  upsertRun(s: Pick<RunsData, 'runs'>, r: Run): Partial<RunsData> {
    const runs = cloneRunMap(s.runs);
    runs[r.id] = r;
    return { runs };
  },
  setRuns(_s: Pick<RunsData, 'runs'>, list: Run[]): Partial<RunsData> {
    const runs = emptyRunMap();
    for (const r of list) runs[r.id] = r;
    return { runs };
  },
  /** Dedupes by `(runId, seq)` — the runner replays its offline buffer after a reconnect, and the
   *  server itself also dedupes, but a duplicate push arriving here anyway (a retried ack, a second
   *  tab's socket) must not double a transcript line. Keeps the events sorted by `seq` in case a
   *  replay arrives out of order relative to what's already stored. */
  applyEvent(s: Pick<RunsData, 'eventsByRun'>, e: RunEventEnvelope): Partial<RunsData> {
    const existing = s.eventsByRun[e.runId] ?? [];
    if (existing.some((x) => x.seq === e.seq)) return {};
    const merged = existing.length === 0 || (existing[existing.length - 1]?.seq ?? 0) < e.seq
      ? [...existing, e]
      : [...existing, e].sort((a, b) => a.seq - b.seq);
    return { eventsByRun: { ...s.eventsByRun, [e.runId]: capEventEnvelopes(merged) } };
  },
  setDetail(s: Pick<RunsData, 'runs' | 'eventsByRun'>, d: RunDetail): Partial<RunsData> {
    return {
      runs: { ...s.runs, [d.run.id]: d.run },
      eventsByRun: { ...s.eventsByRun, [d.run.id]: capEventEnvelopes([...d.events].sort((a, b) => a.seq - b.seq)) },
    };
  },
};

export interface RunsActions {
  upsertRun(r: Run): void;
  setRuns(list: Run[]): void;
  applyEvent(e: RunEventEnvelope): void;
  setDetail(d: RunDetail): void;
  setRunnerStatus(s: RunnerStatus): void;

  /** `runs:list` (optionally scoped to a floor/kind); swallows a transport error and keeps whatever
   *  was last known — the runner status banner and `ConnectionBadge` already surface connectivity. */
  refresh(query?: RunListQuery): Promise<void>;
  refreshRunnerStatus(): Promise<void>;
  /** `runs:get`: fetches the full transcript for one run (the list view only carries summaries). */
  loadDetail(runId: string): Promise<void>;
  start(req: RunStartRequest): Promise<Run>;
  followUp(req: RunFollowUpRequest): Promise<Run>;
  stop(runId: string): Promise<Run>;
  reset(): void;
}

export type RunsState = RunsData & RunsActions;

const initialRunsData = (): RunsData => ({
  runs: emptyRunMap(),
  eventsByRun: {},
  runnerStatus: null,
  runsLoaded: false,
  detailLoading: {},
});

/** Fixed label demo quests are "started by" — demo mode has no real admin session (`useRequireAdmin`
 *  already short-circuits there), so there is no token to derive a name from. */
const DEMO_CREATED_BY = 'demo-admin';

export const useRunsStore = create<RunsState>()((set, get) => ({
  ...initialRunsData(),

  upsertRun: (r) => set((s) => reducers.upsertRun(s, r)),
  setRuns: (list) => set((s) => ({ ...reducers.setRuns(s, list), runsLoaded: true })),
  applyEvent: (e) => set((s) => reducers.applyEvent(s, e)),
  setDetail: (d) => set((s) => reducers.setDetail(s, d)),
  setRunnerStatus: (status) => set({ runnerStatus: status }),

  refresh: async (query = {}) => {
    if (isDemo()) {
      set({ runsLoaded: true });
      return;
    }
    try {
      const list = await emitWithAck('runs:list', query);
      get().setRuns(list);
    } catch {
      // Offline / not authorized — leave the last known list; nothing new to show anyway.
    }
  },

  refreshRunnerStatus: async () => {
    if (isDemo()) {
      get().setRunnerStatus(demoRunnerStatus());
      return;
    }
    try {
      const status = await emitWithAck('runner:getStatus');
      get().setRunnerStatus(status);
    } catch {
      // The banner just shows "no status yet" until this succeeds.
    }
  },

  loadDetail: async (runId) => {
    if (isDemo()) return; // demo transcripts already arrive live via applyEvent as the run progresses
    set((s) => ({ detailLoading: { ...s.detailLoading, [runId]: true } }));
    try {
      const detail = await emitWithAck('runs:get', runId);
      get().setDetail(detail);
    } finally {
      set((s) => ({ detailLoading: { ...s.detailLoading, [runId]: false } }));
    }
  },

  start: async (req) => {
    if (isDemo()) {
      return startDemoQuest(req, DEMO_CREATED_BY, { upsertRun: get().upsertRun, applyEvent: get().applyEvent });
    }
    const run = await emitWithAck('runs:start', req);
    get().upsertRun(run);
    return run;
  },

  followUp: async (req) => {
    if (isDemo()) {
      return followUpDemoQuest(req, { upsertRun: get().upsertRun, applyEvent: get().applyEvent, getRun: (id) => getRun(get().runs, id) });
    }
    const run = await emitWithAck('runs:followUp', req);
    get().upsertRun(run);
    return run;
  },

  stop: async (runId) => {
    if (isDemo()) {
      return stopDemoQuest(runId, { upsertRun: get().upsertRun, getRun: (id) => getRun(get().runs, id) });
    }
    const run = await emitWithAck('runs:stop', runId);
    get().upsertRun(run);
    return run;
  },

  reset: () => set(initialRunsData()),
}));

// Server-pushed updates (docs/design/runner-and-helpdesk.md section 3): registered once here, same
// pattern as `stores/authStore.ts`'s `auth:changed` listener, so no other module needs to remember to
// wire these up. `getSocket()` is a lazy singleton either way.
getSocket().on('run:upsert', (r) => useRunsStore.getState().upsertRun(r));
getSocket().on('run:event', (e) => useRunsStore.getState().applyEvent(e));
getSocket().on('runner:status', (s) => useRunsStore.getState().setRunnerStatus(s));
