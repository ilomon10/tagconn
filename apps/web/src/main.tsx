import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { Providers } from './app/providers';
import { App } from './app/App';
import { boot } from './lib/connection';
import { startNotificationWatcher } from './lib/notify';
import { useSettingsStore } from './stores/settingsStore';
import { useOfficeStore } from './stores/officeStore';

// Keep the client-side event ring buffer in line with settings.storage.snapshotEventLimit.
useSettingsStore.subscribe((s, prev) => {
  if (s.settings.storage.snapshotEventLimit !== prev.settings.storage.snapshotEventLimit)
    useOfficeStore.getState().setEventLimit(s.settings.storage.snapshotEventLimit);
});
useOfficeStore.getState().setEventLimit(useSettingsStore.getState().settings.storage.snapshotEventLimit);

startNotificationWatcher();
boot();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
