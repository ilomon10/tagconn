import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open as pickFolder } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { AppInfo, DesktopConfig, InstallResult, LogLine, ServiceId, SetupCheck, SetupFix } from '@tagconn/shared';
import type { Notice } from '../components/ui';
import { runFix, type FixEnv } from './fixes';
import { RpcClientError, toRpcError } from './rpc';
import { initialState, reducer, visibleServices } from './state';
import { native, rpc } from './tauri';

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
  const autoStarted = useRef(false);

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

  const stopAll = useCallback(async () => {
    const ids = visibleServices(config?.runMode ?? 'native');
    for (const id of ids) await service(id, 'stop');
  }, [config?.runMode, service]);

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

  const openOffice = useCallback((inBrowser: boolean) => withBusy(inBrowser ? 'browser' : 'office', () => native.openOffice(inBrowser)), [withBusy]);

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
          await rpc('config.set', { runMode: 'native' }).then(setConfig);
          await recheck();
        },
      };
      await withBusy(`fix:${fix.action}`, () => runFix(fix, env));
    },
    [recheck, config?.serverPort, pickDir, withBusy],
  );

  // Once per app launch: start services (and open the office) when the user asked for it and setup is complete.
  useEffect(() => {
    if (autoStarted.current || !ready || !config || !setupDone || !checks) return;
    if (checks.some((c) => c.required && c.status === 'fail')) return;
    autoStarted.current = true;
    if (!config.autoStartServices) return;
    void (async () => {
      await startAll();
      if (config.openOfficeOnStart) await openOffice(false);
    })();
  }, [ready, config, setupDone, checks, startAll, openOffice]);

  return {
    state, info, config, checks, checking, installResult, notice, setupDone, ready, busy,
    withBusy, setNotice, setSetupDone, saveConfig, recheck, refresh, service, startAll, stopAll,
    install, uninstall, openOffice, loadLogs, pickDir, applyFix, fail, dispatch,
  };
}

export type Desktop = ReturnType<typeof useDesktop>;
