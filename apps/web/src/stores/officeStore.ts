import { create } from 'zustand';
import type { Agent, OfficeEvent, OfficeSnapshot, Project, Session, Task } from '@tagconn/shared';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'demo';
export const ALL_FLOORS = '*';
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
}

const byId = <T extends { id: string }>(items: T[]): Record<string, T> => Object.fromEntries(items.map((i) => [i.id, i]));

export function capEvents(events: OfficeEvent[], limit: number): OfficeEvent[] {
  const cap = Math.max(MIN_EVENT_LIMIT, limit);
  return events.length > cap ? events.slice(events.length - cap) : events;
}

/** Pure reducers — the store below just wires them to zustand. Exported for tests. */
export const reducers = {
  applySnapshot(s: OfficeData, snap: OfficeSnapshot): Partial<OfficeData> {
    const events = [...snap.events].sort((a, b) => a.id - b.id);
    return {
      projects: byId(snap.projects),
      sessions: byId(snap.sessions),
      agents: byId(snap.agents),
      tasks: byId(snap.tasks),
      events: capEvents(events, s.eventLimit),
    };
  },
  upsertProject: (s: OfficeData, p: Project): Partial<OfficeData> => ({ projects: { ...s.projects, [p.id]: p } }),
  upsertSession: (s: OfficeData, x: Session): Partial<OfficeData> => ({ sessions: { ...s.sessions, [x.id]: x } }),
  upsertAgent(s: OfficeData, a: Agent): Partial<OfficeData> {
    const prev = s.agents[a.id];
    // Ignore stale updates that arrive out of order.
    if (prev && prev.updatedAt > a.updatedAt) return {};
    return { agents: { ...s.agents, [a.id]: a } };
  },
  removeAgent(s: OfficeData, id: string): Partial<OfficeData> {
    if (!(id in s.agents)) return {};
    const agents = { ...s.agents };
    delete agents[id];
    return { agents };
  },
  upsertTask: (s: OfficeData, t: Task): Partial<OfficeData> => ({ tasks: { ...s.tasks, [t.id]: t } }),
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
