import { useEffect, useState } from 'react';
import { isEnabled } from '@tauri-apps/plugin-autostart';
import type { DesktopConfig, ServiceId, ServiceStatus } from '@tagconn/shared';
import { activeIn } from '../lib/state';
import { native } from '../lib/tauri';
import { Button, Dialog, Toggle } from './ui';

interface Props {
  config: DesktopConfig;
  services: Partial<Record<ServiceId, ServiceStatus>>;
  onChangeRunMode: (mode: DesktopConfig['runMode']) => Promise<unknown>;
  onSave: (patch: Partial<DesktopConfig>) => Promise<unknown>;
  onError: (e: unknown) => void;
  onClose: () => void;
}

export function SettingsDialog({ config, services, onChangeRunMode, onSave, onError, onClose }: Props) {
  const [port, setPort] = useState(String(config.serverPort));
  const [autostart, setAutostart] = useState<boolean | null>(null);
  useEffect(() => {
    isEnabled().then(setAutostart, () => setAutostart(false));
  }, []);
  const [pendingMode, setPendingMode] = useState<DesktopConfig['runMode'] | null>(null);
  const portNum = Number(port);
  const portValid = Number.isInteger(portNum) && portNum >= 1024 && portNum <= 65535;

  const toggleAutostart = async (on: boolean) => {
    try {
      // Rust creates ~/.config/autostart first (the plugin fails with ENOENT when it is missing).
      await native.setAutostart(on);
      setAutostart(on);
    } catch (e) {
      onError(e);
    }
  };

  return (
    <Dialog title="Settings" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label htmlFor="run-mode" className="mb-1 block text-sm font-medium">
            Run mode
          </label>
          <select id="run-mode" value={config.runMode} onChange={(e) => {
              const mode = e.target.value as DesktopConfig['runMode'];
              if (activeIn(config.runMode, services).length > 0) setPendingMode(mode);
              else void onChangeRunMode(mode);
            }} className="w-full rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-sm">
            <option value="native">Native (recommended)</option>
            <option value="docker">Docker (docker compose)</option>
          </select>
          <p className="mt-1 text-xs text-ink-300">Changing it stops the running services first. It takes effect the next time they start.</p>
        </div>

        <div>
          <label htmlFor="port" className="mb-1 block text-sm font-medium">
            Server port
          </label>
          <div className="flex gap-2">
            <input id="port" inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} aria-invalid={!portValid} aria-describedby="port-hint" className="w-32 rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-sm" />
            <Button variant="primary" disabled={!portValid || portNum === config.serverPort} onClick={() => void onSave({ serverPort: portNum })}>
              Apply
            </Button>
          </div>
          <p id="port-hint" className={portValid ? 'mt-1 text-xs text-ink-300' : 'mt-1 text-xs text-red-300'}>
            {portValid ? 'Restart the server after changing it. The office URL and CORS origins follow.' : 'Enter a port between 1024 and 65535.'}
          </p>
        </div>

        <fieldset>
          <legend className="sr-only">Startup</legend>
          <Toggle label="Start with system" hint="Launch tagconn to the tray when you log in." checked={autostart ?? false} disabled={autostart === null} onChange={(v) => void toggleAutostart(v)} />
          <Toggle label="Start services when the app starts" checked={config.autoStartServices} onChange={(v) => void onSave({ autoStartServices: v })} />
          <Toggle label="Open the office once the server is up" checked={config.openOfficeOnStart} onChange={(v) => void onSave({ openOfficeOnStart: v })} />
        </fieldset>

        {pendingMode && (
          <Dialog title="Switch run mode" onClose={() => setPendingMode(null)}>
            <p className="text-sm">Switching to {pendingMode} mode stops the running {activeIn(config.runMode, services).join(' and ')} first, so nothing keeps holding the port. Continue?</p>
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                data-autofocus
                onClick={async () => {
                  const mode = pendingMode;
                  setPendingMode(null);
                  await onChangeRunMode(mode);
                }}
              >
                Stop services and switch
              </Button>
              <Button onClick={() => setPendingMode(null)}>Cancel</Button>
            </div>
          </Dialog>
        )}

        <p className="text-xs text-ink-300">
          Data folder: <span className="font-pixel text-ink-100">{config.dataDir ?? 'OS default'}</span>
        </p>
      </div>
    </Dialog>
  );
}
