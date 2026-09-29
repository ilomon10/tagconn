import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open as pickFolder } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { AppInfo, DesktopConfig, InstallResult, LogLine, ServiceId, SetupCheck, SetupFix } from '@tagconn/shared';
import type { Notice } from '../components/ui';
import { runFix, type FixEnv } from './fixes';
import { RpcClientError, toRpcError } from './rpc';
import { idsToStop, initialState, reducer, visibleServices, type AppState } from './state';
import { native, rpc, type PairInfo } from './tauri';
import { waitFor } from './wait';
import { blockingChecks, ownServerRunning } from './wizard';

/** How long open-office-on-start waits for the server to report running. */
const OFFICE_WAIT_MS = 60_000;
const SETUP_DONE_KEY = 'tagconn.setupDone';
const readDone = () => {
  try {
    return localStorage.getItem(SETUP_DONE_KEY) === '1';
  } catch {
    return false;
  }
};

export function toNotice(e: unknown): Notice {
  const err = e instanceof RpcClientError ? e : toRpcError(e);
  return { kind: 'error', message: err.message, hint: err.hint };
}

/** All app state and actions; components stay presentational. */
export function useDesktop() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [config, setConfig] = useState<DesktopConfig | null>(null);
  const [checks, setChecks] = useState<SetupCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [installResult, setInstallResult] = useState<InstallResult | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [setupDone, setSetupDoneState] = useState(readDone);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [pairing, setPairing] = useState<PairInfo | null>(null);
  const autoStarted = useRef(false);
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;
  const startAllRef = useRef<() => Promise<void>>(async () => {});

  const fail = useCallback((e: unknown) => setNotice(toNotice(e)), []);

  const withBusy = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy((b) => new Set(b).add(key));
    try {
      return await fn();
    } catch (e) {
      fail(e);
      return undefined;
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(key);
        return n;
      });
    }
  }, [fail]);

  // A notice tied to a condition disappears when it resolves (e.g. the server became running).
  useEffect(() => {
    if (notice?.until?.(state)) setNotice(null);
  }, [notice, state]);

  const recheck = useCallback(async () => {
    setChecking(true);
    try {
      setChecks(await rpc('setup.check'));
    } catch (e) {
      fail(e);
    } finally {
      setChecking(false);
    }
  }, [fail]);

  const refresh = useCallback(async () => {
    try {
      const [i, c, s] = await Promise.all([rpc('app.info'), rpc('config.get'), rpc('service.status')]);
      setInfo(i);
      setConfig(c);
      dispatch({ type: 'services/set', services: s });
      setReady(true);
      void recheck();
    } catch (e) {
      const err = toRpcError(e);
      if (err.code !== 'sidecar_down') fail(err);
    }
  }, [recheck, fail]);

  // Events from Rust: supervisor notifications and the sidecar lifecycle.
  useEffect(() => {
    const subs = [
      listen<unknown>('desktop://notify', (e) => dispatch({ type: 'notify', payload: e.payload })),
      listen<{ reason: string; logs: string[] }>('desktop://sidecar-down', (e) => dispatch({ type: 'sidecar/down', reason: e.payload.reason, logs: e.payload.logs })),
      // The tray (Rust) has no UI of its own: it reports its errors here.
      listen<{ message: string; hint?: string }>('desktop://notice', (e) => setNotice({ kind: 'error', message: e.payload.message, hint: e.payload.hint })),
      listen('desktop://sidecar-relaunched', () =>
        setNotice({
          kind: 'info',
          message: 'The service manager restarted, so your services were stopped.',
          action: { label: 'Start again', run: () => void startAllRef.current() },
          until: (s) => ownServerRunning(s.services),
        }),
      ),
      listen('desktop://sidecar-up', () => {
        dispatch({ type: 'sidecar/up' });
        void refresh();
      }),
    ];
    native
      .sidecarStatus()
      .then((s) => {
        if (s.down) dispatch({ type: 'sidecar/down', reason: s.reason ?? 'The service manager is not running.', logs: s.logs });
        else void refresh();
      })
      .catch(() => void refresh());
    return () => {
      subs.forEach((p) => void p.then((off) => off()));
    };
  }, [refresh]);

  const setSetupDone = useCallback((v: boolean) => {
    setSetupDoneState(v);
    try {
      localStorage.setItem(SETUP_DONE_KEY, v ? '1' : '0');
    } catch {
      /* private mode: the wizard just shows again next launch */
    }
  }, []);

  const saveConfig = useCallback(
    async (patch: Partial<DesktopConfig>) => {
      const next = await withBusy('config', () => rpc('config.set', patch));
      if (next) setConfig(next);
      return next;
    },
    [withBusy],
  );

  const service = useCallback(
    (id: ServiceId, op: 'start' | 'stop' | 'restart') =>
      withBusy(`${id}:${op}`, async () => {
        const s = await rpc(`service.${op}`, { id });
        dispatch({ type: 'notify', payload: { method: 'service.changed', params: s } });
      }),
    [withBusy],
  );

  const startAll = useCallback(async () => {
    const ids = visibleServices(config?.runMode ?? 'native');
    for (const id of ids) await service(id, 'start');
  }, [config?.runMode, service]);
  startAllRef.current = startAll;

  /** Stops every live service regardless of the current run mode. */
  const stopAll = useCallback(async () => {
    for (const id of idsToStop(stateRef.current.services)) await service(id, 'stop');
  }, [service]);

  /** Leaves the old mode cleanly: its services stop first so nothing keeps holding the port. */
  const changeRunMode = useCallback(
    async (runMode: DesktopConfig['runMode']) => {
      const old = visibleServices(config?.runMode ?? 'native');
      for (const id of idsToStop(stateRef.current.services)) if (old.includes(id)) await service(id, 'stop');
      return saveConfig({ runMode });
    },
    [config?.runMode, service, saveConfig],
  );

  const install = useCallback(async () => {
    const r = await withBusy('install', () => rpc('setup.install'));
    if (r) {
      setInstallResult(r);
      void recheck();
    }
    return r;
  }, [withBusy, recheck]);

  const uninstall = useCallback(async () => {
    const r = await withBusy('uninstall', () => rpc('setup.uninstall'));
    if (r) {
      setInstallResult(null);
      void recheck();
    }
    return r;
  }, [withBusy, recheck]);

  /** In the browser the code never goes on a command line: the URL is opened bare and the code shown here. */
  const openOffice = useCallback(
    async (inBrowser: boolean) => {
      const key = inBrowser ? 'browser' : 'office';
      setBusy((b) => new Set(b).add(key));
      try {
        const pair = await native.openOffice(inBrowser);
        if (pair) setPairing(pair);
      } catch (e) {
        const n = toNotice(e);
        // Nearly every failure here is "the server is not up yet": clear the message once it is.
        setNotice(ownServerRunning(stateRef.current.services) ? n : { ...n, until: (s) => ownServerRunning(s.services) });
      } finally {
        setBusy((b) => {
          const n = new Set(b);
          n.delete(key);
          return n;
        });
      }
    },
    [],
  );

  const loadLogs = useCallback(async () => {
    const ids: (ServiceId | 'supervisor')[] = ['server', 'runner', 'docker', 'supervisor'];
    const parts = await withBusy('logs', () => Promise.all(ids.map((service) => rpc('logs.tail', { service, lines: 300 }))));
    if (parts) dispatch({ type: 'logs/set', lines: parts.flat().sort((a: LogLine, b: LogLine) => a.ts - b.ts) });
  }, [withBusy]);

  const pickDir = useCallback(async (): Promise<string | null> => {
    const r = await pickFolder({ directory: true, multiple: false });
    return typeof r === 'string' ? r : null;
  }, []);

  const applyFix = useCallback(
    async (fix: SetupFix, gotoHooks: () => void) => {
      const env: FixEnv = {
        recheck,
        openUrl,
        revealPath: native.revealPath,
        gotoHooks,
        useNextFreePort: async () => {
          const port = await native.findFreePort(config?.serverPort ?? 4317);
          await rpc('config.set', { serverPort: port }).then(setConfig);
          await recheck();
        },
        chooseDataDir: async () => {
          const dir = await pickDir();
          if (!dir) return;
          await rpc('config.set', { dataDir: dir }).then(setConfig);
          await recheck();
        },
        switchToNative: async () => {
          await changeRunMode('native');
          await recheck();
        },
      };
      await withBusy(`fix:${fix.action}`, () => runFix(fix, env));
    },
    [recheck, config?.serverPort, pickDir, withBusy, changeRunMode],
  );

  // Once per app launch: start services (and open the office) when the user asked for it and setup is complete.
  useEffect(() => {
    if (autoStarted.current || !ready || !config || !setupDone || !checks) return;
    if (blockingChecks(checks, ownServerRunning(state.services)).length > 0) return;
    autoStarted.current = true;
    if (!config.autoStartServices) return;
    void (async () => {
      await startAll();
      if (!config.openOfficeOnStart) return;
      // service.start resolves once the service runs; still wait for the running notification (bounded) before pairing.
      const up = await waitFor(() => ownServerRunning(stateRef.current.services), OFFICE_WAIT_MS);
      if (up) await openOffice(false);
      else setNotice({ kind: 'error', message: 'The server did not come up in time, so the office was not opened.', hint: 'Check the logs, then use Open office once the server is running.' });
    })();
  }, [ready, config, setupDone, checks, state.services, startAll, openOffice]);

  return {
    state, info, config, checks, pairing, setPairing, changeRunMode, checking, installResult, notice, setupDone, ready, busy,
    withBusy, setNotice, setSetupDone, saveConfig, recheck, refresh, service, startAll, stopAll,
    install, uninstall, openOffice, loadLogs, pickDir, applyFix, fail, dispatch,
  };
}

export type Desktop = ReturnType<typeof useDesktop>;
