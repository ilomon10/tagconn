import { create } from 'zustand';
import { MULTIVERSE_FLOOR_ID, type Agent, type OfficeEvent, type OfficeSnapshot, type Project, type Session, type Task } from '@tagconn/shared';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'demo';
/** M8 8h: the Multiverse floor replaced "All floors", keeping the same `'*'` id/subscription — see
 *  `MULTIVERSE_FLOOR_ID` and docs/design/living-office.md section 6 (L7). */
export const ALL_FLOORS = MULTIVERSE_FLOOR_ID;
export const DEFAULT_EVENT_LIMIT = 200;
/** Never keep fewer than this many events client-side, even if the server snapshots fewer. */
export const MIN_EVENT_LIMIT = 50;

export interface OfficeData {
  projects: Record<string, Project>;
  sessions: Record<string, Session>;
  agents: Record<string, Agent>;
  tasks: Record<string, Task>;
  /** Oldest first, deduped by id, capped at `eventLimit`. */
  events: OfficeEvent[];
  eventLimit: number;
  selectedProjectId: string;
  connection: ConnectionState;
  connectionError?: string;
  /** M8 8h: project id → last time the web saw a live (not `done`) agent there (`Agent.updatedAt`).
   *  Feeds `planMultiverse`'s realm hysteresis (docs/design/living-office.md section 6.1) so a realm
   *  doesn't flicker out the instant its last agent goes idle/done. Only ever grows; a realm simply
   *  ages out once `now - lastLiveAt` exceeds `office.idleLeaveSec`. */
  lastLiveAt: Record<string, number>;
  /** M8 8b: project id → agent id pinned as Guild Master from the GM sessions popover ("Pin as
   *  Guild Master"), overriding the usual hysteresis until that session ends (auto-pruned below). */
  pinnedPrimary: Record<string, string>;
}

const byId = <T extends { id: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map((i) => [i.id, i]));

export function capEvents(events: OfficeEvent[], limit: number): OfficeEvent[] {
  const cap = Math.max(MIN_EVENT_LIMIT, limit);
  return events.length > cap ? events.slice(events.length - cap) : events;
}

/** `lastLiveAt[projectId]` only ever moves forward — a project's realm hysteresis (`planMultiverse`)
 *  depends on it never rewinding when events arrive out of order or a snapshot replays old data. */
const bumpLastLiveAt = (map: Record<string, number>, projectId: string, at: number): Record<string, number> =>
  (map[projectId] ?? 0) >= at ? map : { ...map, [projectId]: at };

/** Folds every live (not `done`) agent's `updatedAt` into `lastLiveAt`, keyed by project. Exported
 *  for tests; used by `applySnapshot` and `upsertAgent`. */
export function foldLastLiveAt(map: Record<string, number>, agents: readonly Agent[]): Record<string, number> {
  let next = map;
  for (const a of agents) if (a.status !== 'done') next = bumpLastLiveAt(next, a.projectId, a.updatedAt);
  return next;
}

/** A pin is only good "until that session ends" (design section 5): drop any pin whose agent is
 *  gone, done, or whose session has ended. Returns `pinnedPrimary` unchanged (same reference) when
 *  nothing needed pruning, so callers can skip a state update. */
export function prunePins(pinnedPrimary: Record<string, string>, agents: Record<string, Agent>, sessions: Record<string, Session>): Record<string, string> {
  let changed = false;
  const next: Record<string, string> = {};
  for (const [projectId, agentId] of Object.entries(pinnedPrimary)) {
    const agent = agents[agentId];
    const alive = !!agent && agent.status !== 'done' && sessions[agent.sessionId]?.status !== 'ended';
    if (alive) next[projectId] = agentId;
    else changed = true;
  }
  return changed ? next : pinnedPrimary;
}

/** Pure reducers — the store below just wires them to zustand. Exported for tests. */
export const reducers = {
  applySnapshot(s: OfficeData, snap: OfficeSnapshot): Partial<OfficeData> {
    const events = [...snap.events].sort((a, b) => a.id - b.id);
    const agents = byId(snap.agents);
    const sessions = byId(snap.sessions);
    return {
      projects: byId(snap.projects),
      sessions,
      agents,
      tasks: byId(snap.tasks),
      events: capEvents(events, s.eventLimit),
      lastLiveAt: foldLastLiveAt(s.lastLiveAt, snap.agents),
      pinnedPrimary: prunePins(s.pinnedPrimary, agents, sessions),
    };
  },
  upsertProject: (s: OfficeData, p: Project): Partial<OfficeData> => ({ projects: { ...s.projects, [p.id]: p } }),
  upsertSession(s: OfficeData, x: Session): Partial<OfficeData> {
    const sessions = { ...s.sessions, [x.id]: x };
    return { sessions, pinnedPrimary: prunePins(s.pinnedPrimary, s.agents, sessions) };
  },
  upsertAgent(s: OfficeData, a: Agent): Partial<OfficeData> {
    const prev = s.agents[a.id];
    // Ignore stale updates that arrive out of order.
    if (prev && prev.updatedAt > a.updatedAt) return {};
    const agents = { ...s.agents, [a.id]: a };
    return {
      agents,
      lastLiveAt: foldLastLiveAt(s.lastLiveAt, [a]),
      pinnedPrimary: prunePins(s.pinnedPrimary, agents, s.sessions),
    };
  },
  removeAgent(s: OfficeData, id: string): Partial<OfficeData> {
    const removed = s.agents[id];
    if (!removed) return {};
    const agents = { ...s.agents };
    delete agents[id];
    return {
      agents,
      lastLiveAt: foldLastLiveAt(s.lastLiveAt, [removed]),
      pinnedPrimary: prunePins(s.pinnedPrimary, agents, s.sessions),
    };
  },
  upsertTask: (s: OfficeData, t: Task): Partial<OfficeData> => ({ tasks: { ...s.tasks, [t.id]: t } }),
  /** "Pin as Guild Master" (design section 5): sticks the floor's GM to this session's main agent
   *  until it ends (`prunePins` above clears it automatically). */
  pinPrimary: (s: OfficeData, projectId: string, agentId: string): Partial<OfficeData> => ({ pinnedPrimary: { ...s.pinnedPrimary, [projectId]: agentId } }),
  unpinPrimary(s: OfficeData, projectId: string): Partial<OfficeData> {
    if (!(projectId in s.pinnedPrimary)) return {};
    const pinnedPrimary = { ...s.pinnedPrimary };
    delete pinnedPrimary[projectId];
    return { pinnedPrimary };
  },
  addEvent(s: OfficeData, e: OfficeEvent): Partial<OfficeData> {
    if (s.events.some((x) => x.id === e.id)) return {};
    const last = s.events[s.events.length - 1];
    const events = !last || last.id < e.id ? [...s.events, e] : [...s.events, e].sort((a, b) => a.id - b.id);
    return { events: capEvents(events, s.eventLimit) };
  },
  /** Prepend older events fetched from REST (pagination). Not capped: the user asked for them. */
  prependEvents(s: OfficeData, older: OfficeEvent[]): Partial<OfficeData> {
    const known = new Set(s.events.map((e) => e.id));
    const merged = [...older.filter((e) => !known.has(e.id)), ...s.events].sort((a, b) => a.id - b.id);
    return { events: merged };
  },
  setEventLimit: (s: OfficeData, limit: number): Partial<OfficeData> => ({ eventLimit: limit, events: capEvents(s.events, limit) }),
};

export const initialOfficeData = (): OfficeData => ({
  projects: {},
  sessions: {},
  agents: {},
  tasks: {},
  events: [],
  eventLimit: DEFAULT_EVENT_LIMIT,
  selectedProjectId: ALL_FLOORS,
  connection: 'idle',
  lastLiveAt: {},
  pinnedPrimary: {},
});

export interface OfficeActions {
  applySnapshot(snap: OfficeSnapshot): void;
  upsertProject(p: Project): void;
  upsertSession(s: Session): void;
  upsertAgent(a: Agent): void;
  removeAgent(id: string): void;
  upsertTask(t: Task): void;
  addEvent(e: OfficeEvent): void;
  prependEvents(e: OfficeEvent[]): void;
  setEventLimit(limit: number): void;
  selectProject(id: string): void;
  setConnection(c: ConnectionState, error?: string): void;
  /** "Pin as Guild Master" (GM sessions popover): sticks the floor's GM to this agent's session. */
  pinPrimary(projectId: string, agentId: string): void;
  /** Un-pins early (the popover also offers this); pruning otherwise handles it once the session ends. */
  unpinPrimary(projectId: string): void;
  reset(): void;
}

export type OfficeState = OfficeData & OfficeActions;

export const useOfficeStore = create<OfficeState>()((set) => ({
  ...initialOfficeData(),
  applySnapshot: (snap) => set((s) => reducers.applySnapshot(s, snap)),
  upsertProject: (p) => set((s) => reducers.upsertProject(s, p)),
  upsertSession: (x) => set((s) => reducers.upsertSession(s, x)),
  upsertAgent: (a) => set((s) => reducers.upsertAgent(s, a)),
  removeAgent: (id) => set((s) => reducers.removeAgent(s, id)),
  upsertTask: (t) => set((s) => reducers.upsertTask(s, t)),
  addEvent: (e) => set((s) => reducers.addEvent(s, e)),
  prependEvents: (e) => set((s) => reducers.prependEvents(s, e)),
  setEventLimit: (limit) => set((s) => reducers.setEventLimit(s, limit)),
  selectProject: (id) => set({ selectedProjectId: id }),
  setConnection: (connection, connectionError) => set({ connection, connectionError }),
  pinPrimary: (projectId, agentId) => set((s) => reducers.pinPrimary(s, projectId, agentId)),
  unpinPrimary: (projectId) => set((s) => reducers.unpinPrimary(s, projectId)),
  reset: () =>
    set((s) => ({ ...initialOfficeData(), selectedProjectId: s.selectedProjectId, eventLimit: s.eventLimit, connection: s.connection })),
}));

/** Filter helper: does an item belong to the selected floor? */
export const onFloor = (selected: string, projectId: string) => selected === ALL_FLOORS || selected === projectId;

/**
 * Floors to list in a picker: archived projects are hidden unless `showArchived` is set, or the
 * floor is the one currently selected (so switching away from an archived floor doesn't strand you).
 */
export function visibleProjects(projects: Record<string, Project>, opts: { selectedId?: string; showArchived?: boolean } = {}): Project[] {
  const { selectedId, showArchived = false } = opts;
  return Object.values(projects)
    .filter((p) => showArchived || !p.archived || p.id === selectedId)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
