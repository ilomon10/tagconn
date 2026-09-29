import { useEffect, useState } from 'react';
import { visibleServices } from '../lib/state';
import { bannerChecks } from '../lib/wizard';
import { native, rpc, type UpdateInfo } from '../lib/tauri';
import type { Desktop } from '../lib/useDesktop';
import { LogsDrawer } from './LogsDrawer';
import { ServiceRow } from './ServiceRow';
import { SettingsDialog } from './SettingsDialog';
import { Button, CheckIcon, Dialog } from './ui';

type Modal = null | 'logs' | 'settings' | 'uninstall' | 'update' | { copy: string };

export function Panel({ d, onOpenSetup }: { d: Desktop; onOpenSetup: () => void }) {
  const [modal, setModal] = useState<Modal>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updatesOn, setUpdatesOn] = useState(false);
  useEffect(() => {
    native.updatesConfigured().then(setUpdatesOn, () => setUpdatesOn(false));
  }, []);
  const close = () => setModal(null);
  const config = d.config;
  const runMode = config?.runMode ?? 'native';
  const failed = bannerChecks(d.setupDone, d.checks, d.state.services);

  /** Clipboard needs a user gesture in WebKit; if it still fails, show the text to select by hand. */
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      d.setNotice({ kind: 'info', message: `${what} copied to the clipboard.` });
    } catch {
      setModal({ copy: text });
    }
  };

  const diagnostics = async () => {
    const r = await d.withBusy('diagnostics', () => rpc('diagnostics.collect'));
    if (r) await copy(r.text, 'Diagnostics');
  };

  const checkUpdates = async () => {
    const r = await d.withBusy('update', native.checkUpdate);
    if (r === undefined) return;
    if (r === null) d.setNotice({ kind: 'info', message: 'You are on the latest version.' });
    else {
      setUpdate(r);
      setModal('update');
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">tagconn</h1>
          <p className="text-xs text-ink-300">
            {d.info ? `v${d.info.appVersion} · ${d.info.platform}` : 'Loading'} · {runMode} mode
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void d.openOffice(false)} disabled={d.busy.has('office')}>
            Open office
          </Button>
          <Button onClick={() => void d.openOffice(true)} disabled={d.busy.has('browser')}>
            Open in browser
          </Button>
        </div>
      </header>

      {failed.length > 0 && (
        <section aria-labelledby="checks-title" className="space-y-2 rounded-lg border border-red-500/60 bg-red-950 p-3 text-red-50">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="checks-title" className="text-sm font-semibold">
              Setup problems
            </h2>
            <Button onClick={onOpenSetup}>Run setup again</Button>
          </div>
          <ul className="space-y-2">
            {failed.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start gap-3 text-sm">
                <CheckIcon status={c.status} />
                <div className="min-w-48 flex-1">
                  <p className="font-medium">{c.title}</p>
                  <p className="whitespace-pre-wrap text-xs opacity-90">{c.detail}</p>
                </div>
                {c.fix && (
                  <Button disabled={d.busy.has(`fix:${c.fix.action}`)} onClick={() => void d.applyFix(c.fix!, onOpenSetup)}>
                    {c.fix.label}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="services-title" className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 id="services-title" className="text-sm font-semibold">
            Services
          </h2>
          <div className="flex gap-2">
            <Button onClick={() => void d.startAll()}>Start all</Button>
            <Button onClick={() => void d.stopAll()}>Stop all</Button>
          </div>
        </div>
        <ul className="space-y-2">
          {visibleServices(runMode).map((id) => (
            <ServiceRow key={id} id={id} status={d.state.services[id]} busy={(k) => d.busy.has(k)} onOp={(sid, op) => void d.service(sid, op)} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="tools-title" className="space-y-2">
        <h2 id="tools-title" className="text-sm font-semibold">
          Tools
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setModal('logs')}>Logs</Button>
          <Button onClick={() => setModal('settings')} disabled={!config}>
            Settings
          </Button>
          <Button onClick={onOpenSetup}>Run setup again</Button>
          <Button onClick={() => void diagnostics()} disabled={d.busy.has('diagnostics')}>
            Copy diagnostics
          </Button>
          <Button onClick={() => void checkUpdates()} disabled={!updatesOn || d.busy.has('update')} title={updatesOn ? undefined : 'Available in release builds'}>
            Check for updates
          </Button>
          <Button variant="danger" onClick={() => setModal('uninstall')}>
            Uninstall hooks
          </Button>
        </div>
        {!updatesOn && <p className="text-xs text-ink-300">Updates are available in release builds.</p>}
      </section>

      {modal === 'logs' && <LogsDrawer logs={d.state.logs} onLoad={() => void d.loadLogs()} onCopy={(t) => void copy(t, 'Logs')} onClose={close} />}
      {modal === 'settings' && config && <SettingsDialog config={config} services={d.state.services} onChangeRunMode={d.changeRunMode} onSave={d.saveConfig} onError={d.fail} onClose={close} />}
      {modal === 'uninstall' && (
        <Dialog title="Uninstall hooks" onClose={close}>
          <p className="text-sm">This removes the tagconn hook entries from your Claude Code settings.json (a backup is made first) and the tagconn staff roles and skills. Your other settings are not touched.</p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="danger"
              data-autofocus
              onClick={async () => {
                close();
                const r = await d.uninstall();
                if (r) d.setNotice({ kind: 'info', message: `Hooks removed (${r.changed.length} files changed).${r.backup ? ` Backup: ${r.backup}` : ''}` });
              }}
            >
              Uninstall
            </Button>
            <Button onClick={close}>Cancel</Button>
          </div>
        </Dialog>
      )}
      {modal === 'update' && update && (
        <Dialog title="Update available" onClose={close}>
          <p className="text-sm">Version {update.version} is available.</p>
          {update.notes && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs text-ink-300">{update.notes}</pre>}
          <p className="mt-2 text-xs text-ink-300">The services stop, the update installs (its signature is verified) and the app restarts.</p>
          <div className="mt-3 flex gap-2">
            <Button
              variant="primary"
              data-autofocus
              onClick={async () => {
                close();
                await d.withBusy('update', native.installUpdate);
              }}
            >
              Install and restart
            </Button>
            <Button onClick={close}>Later</Button>
          </div>
        </Dialog>
      )}
      {typeof modal === 'object' && modal && 'copy' in modal && (
        <Dialog title="Copy manually" onClose={close}>
          <p className="mb-2 text-sm text-ink-300">The clipboard is not available. Select the text and copy it.</p>
          <textarea readOnly data-autofocus aria-label="Text to copy" defaultValue={modal.copy} className="h-64 w-full rounded-md border border-ink-600 bg-ink-950 p-2 font-pixel text-xs" onFocus={(e) => e.currentTarget.select()} />
        </Dialog>
      )}
    </div>
  );
}
