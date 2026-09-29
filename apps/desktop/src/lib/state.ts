import { DESKTOP_NOTIFICATIONS, SERVICE_IDS, type LogLine, type ServiceId, type ServiceStatus } from '@tagconn/shared';

export const MAX_LOG_LINES = 1000;

export interface AppState {
  services: Partial<Record<ServiceId, ServiceStatus>>;
  logs: LogLine[];
  /** Set when the Rust side gave up on the sidecar; drives the blocking panel. */
  sidecarDown: { reason: string; logs: string[] } | null;
}

export const initialState: AppState = { services: {}, logs: [], sidecarDown: null };

export type Action =
  | { type: 'services/set'; services: ServiceStatus[] }
  | { type: 'notify'; payload: unknown }
  | { type: 'logs/set'; lines: LogLine[] }
  | { type: 'sidecar/down'; reason: string; logs: string[] }
  | { type: 'sidecar/up' }
  | { type: 'services/reset' };

const cap = (lines: LogLine[]) => (lines.length > MAX_LOG_LINES ? lines.slice(lines.length - MAX_LOG_LINES) : lines);

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'services/set':
      return { ...state, services: Object.fromEntries(action.services.map((s) => [s.id, s])) };
    case 'notify': {
      // Payloads come from the supervisor: validate, and drop anything that is not a known notification.
      const p = action.payload as { method?: unknown; params?: unknown } | null;
      if (p?.method === 'service.changed') {
        const r = DESKTOP_NOTIFICATIONS['service.changed'].safeParse(p.params);
        return r.success ? { ...state, services: { ...state.services, [r.data.id]: r.data } } : state;
      }
      if (p?.method === 'log.line') {
        const r = DESKTOP_NOTIFICATIONS['log.line'].safeParse(p.params);
        return r.success ? { ...state, logs: cap([...state.logs, r.data]) } : state;
      }
      return state;
    }
    case 'logs/set': {
      // Keep live lines that arrived while the tail was loading (newer than its last line).
      const last = action.lines.at(-1)?.ts ?? 0;
      const live = state.logs.filter((l) => l.ts > last);
      return { ...state, logs: cap([...action.lines, ...live]) };
    }
    // The supervisor was relaunched: its services died with it, so nothing is known to run until a refresh.
    case 'services/reset':
      return { ...state, services: {} };
    case 'sidecar/down':
      return { ...state, sidecarDown: { reason: action.reason, logs: action.logs } };
    case 'sidecar/up':
      return { ...state, sidecarDown: null };
  }
}

export function filterLogs(lines: LogLine[], service: ServiceId | 'supervisor' | 'all'): LogLine[] {
  return service === 'all' ? lines : lines.filter((l) => l.service === service);
}

export function formatLogLine(l: LogLine): string {
  const t = new Date(l.ts).toISOString().slice(11, 23);
  return `${t} [${l.service}${l.stream === 'stderr' ? '!' : ''}] ${l.line}`;
}

/** Which services the panel lists: docker only in docker mode, and never the native server then. */
export function visibleServices(runMode: 'native' | 'docker'): ServiceId[] {
  return runMode === 'docker' ? ['docker', 'runner'] : ['server', 'runner'];
}

export type Light = 'green' | 'amber' | 'red' | 'grey' | 'striped';
export function lightFor(state: ServiceStatus['state'] | undefined): Light {
  switch (state) {
    case 'running':
      return 'green';
    case 'starting':
    case 'stopping':
      return 'amber';
    case 'crashed':
      return 'red';
    case 'unavailable':
      return 'striped';
    default:
      return 'grey';
  }
}

/** Stop all / Quit stop every service regardless of run mode, so nothing keeps holding a port uncontrolled. */
export function idsToStop(services: Partial<Record<ServiceId, ServiceStatus>>): ServiceId[] {
  return SERVICE_IDS.filter((id) => {
    const st = services[id]?.state;
    return st !== 'stopped' && st !== 'unavailable';
  });
}

/** Services of `runMode` that are up or coming up (a mode switch must stop them first). */
export function activeIn(runMode: 'native' | 'docker', services: Partial<Record<ServiceId, ServiceStatus>>): ServiceId[] {
  return visibleServices(runMode).filter((id) => {
    const st = services[id]?.state;
    return st === 'running' || st === 'starting' || st === 'stopping';
  });
}
