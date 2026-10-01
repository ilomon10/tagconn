// STUB (W0b): W1-3 owns the body (docs/design/office-life.md 3.3.2). The queue never shows anything yet.
import type { AlertInput, AlertItem, AlertQueueState, AlertSettings } from './types';

/** tokens = burst */
export function initialAlertQueue(cfg: AlertSettings, nowMs: number): AlertQueueState {
  return { tokens: cfg.burst, refilledAt: nowMs, lastShown: {}, lastKey: {}, pending: [], visible: [], seq: 0 };
}

export function offerAlert(s: AlertQueueState, _input: AlertInput, _cfg: AlertSettings, _nowMs: number): AlertQueueState {
  return s;
}

export function tickAlerts(
  s: AlertQueueState, _cfg: AlertSettings, _nowMs: number, _hidden: boolean,
): { state: AlertQueueState; shown: readonly AlertItem[] } {
  return { state: s, shown: [] };
}

export function dismissAlert(s: AlertQueueState, _id: string): AlertQueueState {
  return s;
}
