import type { Notice } from '../components/ui';
import type { AppState } from './state';
import { ownServerRunning } from './wizard';

/** How long a purely informational confirmation (e.g. "Copied") stays. */
export const INFO_DISMISS_MS = 3000;

/**
 * An error that nearly always means "the server is not up yet" clears itself once it is. Applied to the
 * in-app Open office failure and to the tray's, so both behave the same.
 */
export function serverNotice(n: Notice, services: AppState['services']): Notice {
  return ownServerRunning(services) ? n : { ...n, until: (s) => ownServerRunning(s.services) };
}

/** The tray (Rust) reports its errors as `desktop://notice`. */
export function trayNotice(payload: { message: string; hint?: string }, services: AppState['services']): Notice {
  return serverNotice({ kind: 'error', message: payload.message, hint: payload.hint }, services);
}

/**
 * After a sidecar relaunch. No `until`: the UI store may still say "running" for a moment, and the notice
 * is only meaningful until the user restarts the services (Start again) or dismisses it.
 */
export function relaunchedNotice(startAgain: () => void): Notice {
  return { kind: 'info', message: 'The service manager restarted, so your services were stopped.', action: { label: 'Start again', run: startAgain } };
}

export const copiedNotice = (): Notice => ({ kind: 'info', message: 'Copied to the clipboard.', dismissAfterMs: INFO_DISMISS_MS });
