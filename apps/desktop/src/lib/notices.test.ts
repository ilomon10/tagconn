import { describe, expect, it } from 'vitest';
import type { ServiceStatus } from '@tagconn/shared';
import { copiedNotice, INFO_DISMISS_MS, relaunchedNotice, serverNotice, trayNotice } from './notices';
import { initialState, reducer, type AppState } from './state';

const running = (id: 'server' | 'runner' = 'server'): ServiceStatus => ({ id, state: 'running', since: 1, restarts: 0 });
const withServer = (): AppState => reducer(initialState, { type: 'services/set', services: [running()] });

describe('notices', () => {
  it('the relaunched notice survives a store that still says running', () => {
    // Order used by useDesktop: reset the services, then set the notice (no auto-clear condition).
    const state = reducer(withServer(), { type: 'services/reset' });
    const n = relaunchedNotice(() => {});
    expect(state.services).toEqual({});
    expect(n.until).toBeUndefined();
    expect(n.action?.label).toBe('Start again');
  });

  it('a tray error clears when the server runs, like the in-app path', () => {
    const n = trayNotice({ message: 'The server is not running.' }, {});
    expect(n.kind).toBe('error');
    expect(n.until?.(initialState)).toBe(false);
    expect(n.until?.(withServer())).toBe(true);
  });

  it('a tray or in-app error while the server already runs stays until dismissed', () => {
    expect(trayNotice({ message: 'x' }, withServer().services).until).toBeUndefined();
    expect(serverNotice({ kind: 'error', message: 'x' }, withServer().services).until).toBeUndefined();
  });

  it('the copied confirmation auto-dismisses', () => {
    expect(copiedNotice().dismissAfterMs).toBe(INFO_DISMISS_MS);
  });
});

describe('services/reset', () => {
  it('forgets every service', () => {
    expect(reducer(withServer(), { type: 'services/reset' }).services).toEqual({});
  });
});
