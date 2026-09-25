import { ALL_FLOORS, useOfficeStore } from '../stores/officeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { registerLayoutEvents, useLayoutStore } from '../stores/layoutStore';
import { registerHeroEvents, useHeroStore } from '../stores/heroStore';
import { emitWithAck, getSocket } from './socket';
import { startDemo } from './mock';
import { DEFAULT_ROLES } from './defaultRoles';
import { defaultSettings } from '@tagconn/shared';

/**
 * Owns the data source: either the live socket.io connection or the demo simulator.
 * Both feed the very same store actions.
 */

let stopDemoFn: (() => void) | null = null;
let liveWired = false;

export const isDemoRequested = () => new URLSearchParams(window.location.search).get('demo') === '1';

function wireLive() {
  if (liveWired) return;
  liveWired = true;
  const s = getSocket();
  const office = () => useOfficeStore.getState();
  const cfg = () => useSettingsStore.getState();

  s.on('connect', () => {
    office().setConnection('connected');
    void resync();
  });
  s.on('disconnect', (reason) => office().setConnection('disconnected', reason));
  s.on('connect_error', (err) => office().setConnection('disconnected', err.message));
  s.io.on('reconnect_attempt', () => {
    if (office().connection !== 'demo') office().setConnection('connecting');
  });

  // Note: this server never pushes a bare 'snapshot' event — the only delivery is the ack reply to
  // 'office:subscribe' (handled in `resync()` below). Kept for any future/alternate server that does.
  s.on('snapshot', (snap) => {
    office().applySnapshot(snap);
    if (snap.layouts) useLayoutStore.getState().setLayouts(snap.layouts);
    if (snap.heroes) useHeroStore.getState().setHeroes(snap.heroes);
  });
  s.on('project:upsert', (p) => office().upsertProject(p));
  s.on('session:upsert', (x) => office().upsertSession(x));
  s.on('agent:upsert', (a) => office().upsertAgent(a));
  s.on('agent:remove', (id) => office().removeAgent(id));
  s.on('task:upsert', (t) => office().upsertTask(t));
  s.on('event:new', (e) => office().addEvent(e));
  s.on('settings:changed', (x) => cfg().setSettings(x));
  s.on('roles:changed', (r) => cfg().setRoles(r));
  registerLayoutEvents(s);
  registerHeroEvents(s);
}

/** Fetch everything after (re)connecting. We subscribe to all floors and filter client-side. */
async function resync() {
  try {
    const [snap, settings, roles] = await Promise.all([
      emitWithAck('office:subscribe', ALL_FLOORS),
      emitWithAck('settings:get'),
      emitWithAck('roles:list'),
    ]);
    useSettingsStore.getState().setSettings(settings);
    useSettingsStore.getState().setRoles(roles);
    useOfficeStore.getState().applySnapshot(snap);
    // M7: layouts are global (not per project), so the snapshot carries all of them (7b). Pre-M7
    // servers and test fixtures omit the field; `layoutForProject` falls back to `DEFAULT_LAYOUT`.
    useLayoutStore.getState().setLayouts(snap.layouts ?? []);
    // M8 8i: heroes are global too (bound heroes must look the same on every floor/tab). Pre-M8
    // servers and fixtures omit the field.
    useHeroStore.getState().setHeroes(snap.heroes ?? []);
  } catch (err) {
    console.warn('[tagconn] resync failed', err);
  }
}

export function startLive() {
  stopDemo();
  wireLive();
  useOfficeStore.getState().setConnection('connecting');
  const s = getSocket();
  if (!s.connected) s.connect();
}

export function enterDemo() {
  const s = getSocket();
  if (s.active) s.disconnect();
  stopDemo();
  useOfficeStore.getState().reset();
  useOfficeStore.getState().setConnection('demo');
  const cfg = useSettingsStore.getState();
  if (!cfg.settingsLoaded) cfg.setSettings(defaultSettings());
  if (!cfg.rolesLoaded) cfg.setRoles(DEFAULT_ROLES);
  stopDemoFn = startDemo();
}

function stopDemo() {
  stopDemoFn?.();
  stopDemoFn = null;
}

export function exitDemo() {
  stopDemo();
  useOfficeStore.getState().reset();
  const url = new URL(window.location.href);
  if (url.searchParams.has('demo')) {
    url.searchParams.delete('demo');
    window.history.replaceState(null, '', url);
  }
  startLive();
}

export const isDemo = () => useOfficeStore.getState().connection === 'demo';

export function boot() {
  if (isDemoRequested()) enterDemo();
  else startLive();
}
