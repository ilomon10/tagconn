import { invoke } from '@tauri-apps/api/core';
import { createRpc } from './rpc';

export const rpc = createRpc(invoke);
export { invoke };

export interface SidecarStatus {
  down: boolean;
  reason: string | null;
  logs: string[];
}
export interface PairInfo {
  code: string;
  expiresAt: number;
}
export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** Thin wrappers over the app's own Rust commands (src-tauri/src/commands.rs). */
export const native = {
  sidecarStatus: () => invoke<SidecarStatus>('sidecar_status'),
  sidecarRetry: () => invoke<void>('sidecar_retry'),
  /** In-app window: null. Browser: the bare URL is opened and the code returned to show in this UI. */
  openOffice: (inBrowser: boolean) => invoke<PairInfo | null>('open_office', { inBrowser }),
  setAutostart: (enabled: boolean) => invoke<void>('set_autostart', { enabled }),
  findFreePort: (after: number) => invoke<number>('find_free_port', { after }),
  revealPath: (path: string) => invoke<void>('reveal_path', { path }),
  updatesConfigured: () => invoke<boolean>('updates_configured'),
  checkUpdate: () => invoke<UpdateInfo | null>('check_update'),
  installUpdate: () => invoke<void>('install_update'),
};
