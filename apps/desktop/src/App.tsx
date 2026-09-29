import { useState } from 'react';
import { Panel } from './components/Panel';
import { SidecarDown } from './components/SidecarDown';
import { NoticeBar } from './components/ui';
import { native } from './lib/tauri';
import { toNotice, useDesktop } from './lib/useDesktop';
import { needsWizard } from './lib/wizard';
import { Wizard } from './components/Wizard';

export function App() {
  const d = useDesktop();
  const [forceWizard, setForceWizard] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      d.setNotice({ kind: 'info', message: 'Copied to the clipboard.' });
    } catch (e) {
      d.setNotice(toNotice(e));
    }
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await native.sidecarRetry();
    } catch (e) {
      d.setNotice(toNotice(e));
    } finally {
      setRetrying(false);
    }
  };

  const showWizard = d.ready && (forceWizard || needsWizard(d.setupDone, d.checks));

  return (
    <div className="flex h-full flex-col">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-cozy focus:px-3 focus:py-1 focus:text-ink-950">
        Skip to content
      </a>
      <div className="px-4 pt-3 empty:hidden">
        <NoticeBar notice={d.notice} onDismiss={() => d.setNotice(null)} />
      </div>
      <main id="main" className="min-h-0 flex-1 overflow-auto">
        {!d.ready ? (
          <p role="status" className="p-6 text-sm text-ink-300">
            {d.state.sidecarDown ? 'The service manager is not running.' : 'Starting the service manager'}
          </p>
        ) : showWizard ? (
          <Wizard
            d={d}
            onFinish={() => {
              d.setSetupDone(true);
              setForceWizard(false);
            }}
          />
        ) : (
          <Panel d={d} onOpenSetup={() => setForceWizard(true)} />
        )}
      </main>
      {d.state.sidecarDown && <SidecarDown reason={d.state.sidecarDown.reason} logs={d.state.sidecarDown.logs} retrying={retrying} onRetry={() => void retry()} onCopy={(t) => void copy(t)} />}
    </div>
  );
}
