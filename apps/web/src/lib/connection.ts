import { ALL_FLOORS, useOfficeStore } from '../stores/officeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { registerLayoutEvents, useLayoutStore } from '../stores/layoutStore';
import { registerHeroEvents, useHeroStore } from '../stores/heroStore';
import { registerProgressEvents, useProgressStore } from '../stores/progressStore';
import { startDemoProgression } from '../features/battle/demoProgression';
import { useReceptionistStore } from '../stores/receptionistStore';
import { emitWithAck, getSocket, heroSocket } from './socket';
import { demoClock, startDemo } from './mock';
import { syncClock, type ClockSync } from '../game/lighting/clock';
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
    // sentAt === receivedAt here (no round trip): never overwrite a better midpoint measurement from resync().
    if (!office().clockSync) {
      const at = Date.now();
      office().setClockSync(syncClock(snap.clock, at, at));
    }
    if (snap.layouts) useLayoutStore.getState().setLayouts(snap.layouts);
    if (snap.heroes) useHeroStore.getState().setHeroes(snap.heroes);
    useProgressStore.getState().setAll(snap.progress ?? []);
  });
  s.on('project:upsert', (p) => office().upsertProject(p));
  s.on('project:merged', ({ from, into }) => {
    office().mergeProject(from, into);
    // The server moved the child's heroes without broadcasting each one: re-home them in place, then re-read the survivor's.
    useHeroStore.getState().moveProject(from, into);
    useReceptionistStore.getState().moveProject(from, into);
    const seen = useHeroStore.getState().mutations;
    void heroSocket.list({ projectId: into }).then(
      (list) => {
        // A hero event landed while the list was in flight: the list may be older than it (e.g. undo a hero:remove).
        if (useHeroStore.getState().mutations !== seen) return;
        list.forEach((h) => useHeroStore.getState().upsertHero(h));
      },
      () => {},
    );
  });
  s.on('session:upsert', (x) => office().upsertSession(x));
  s.on('agent:upsert', (a) => office().upsertAgent(a));
  s.on('agent:remove', (id) => office().removeAgent(id));
  s.on('task:upsert', (t) => office().upsertTask(t));
  s.on('event:new', (e) => office().addEvent(e));
  s.on('settings:changed', (x) => cfg().setSettings(x));
  s.on('roles:changed', (r) => cfg().setRoles(r));
  registerLayoutEvents(s);
  registerHeroEvents(s);
  registerProgressEvents(s);
}

/** Fetch everything after (re)connecting. We subscribe to all floors and filter client-side. */
async function resync() {
  try {
    // M16: skew = serverNow minus the midpoint of the subscribe round trip, re-measured on every (re)connect.
    const sentAt = Date.now();
    let sync: ClockSync | undefined;
    const [snap, settings, roles] = await Promise.all([
      emitWithAck('office:subscribe', ALL_FLOORS).then((r) => {
        sync = syncClock(r.clock, sentAt, Date.now());
        return r;
      }),
      emitWithAck('settings:get'),
      emitWithAck('roles:list'),
    ]);
    useSettingsStore.getState().setSettings(settings);
    useSettingsStore.getState().setRoles(roles);
    useOfficeStore.getState().applySnapshot(snap);
    if (sync) useOfficeStore.getState().setClockSync(sync);
    // M7: layouts are global (not per project), so the snapshot carries all of them (7b). Pre-M7
    // servers and test fixtures omit the field; `layoutForProject` falls back to `DEFAULT_LAYOUT`.
    useLayoutStore.getState().setLayouts(snap.layouts ?? []);
    // M8 8i: heroes are global too (bound heroes must look the same on every floor/tab). Pre-M8
    // servers and fixtures omit the field.
    useHeroStore.getState().setHeroes(snap.heroes ?? []);
    // M14: stored hero progress (pre-M14 servers and fixtures omit the field).
    useProgressStore.getState().setAll(snap.progress ?? []);
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
  const at = Date.now();
  useOfficeStore.getState().setClockSync(syncClock(demoClock(at), at, at));
  const stopMock = startDemo();
  const stopProgression = startDemoProgression();
  stopDemoFn = () => {
    stopProgression();
    stopMock();
  };
}

function stopDemo() {
  stopDemoFn?.();
  stopDemoFn = null;
}

export function exitDemo() {
  stopDemo();
  useOfficeStore.getState().reset();
  useProgressStore.getState().setAll([]);
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
