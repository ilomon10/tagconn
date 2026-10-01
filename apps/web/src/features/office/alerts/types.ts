import type { Agent, Settings } from '@tagconn/shared';

export type AlertKind = 'ask' | 'failure' | 'done';
export const ALERT_PRIORITY: Record<AlertKind, number> = { ask: 3, failure: 2, done: 1 };
export type AlertSettings = Settings['office']['alerts'];
export interface AlertInput {
  kind: AlertKind;
  agentId: string;
  at: number;
  /** Dedupe discriminator: the status for ask/done, the tool name for failure. */
  key: string;
  toolName?: string;
  /** Snapshot of the agent at offer time, so the box can still show who it was after the store drops it. */
  agent?: Agent;
}
export interface AlertItem {
  id: string;
  kind: AlertKind;
  /** > 1 = coalesced ("3 heroes need you"). */
  agentIds: readonly string[];
  toolName?: string;
  /** agentId -> snapshot taken at offer time (fallback when the live store no longer has the agent). */
  agents?: Readonly<Record<string, Agent>>;
  createdAt: number;
  shownAt: number | null;
}
export interface AlertQueueState {
  tokens: number;
  refilledAt: number;
  /** agentId -> { at, priority } of the last alert shown for it. */
  lastShown: Readonly<Record<string, { at: number; priority: number }>>;
  /** agentId -> last key offered (drops exact repeats, e.g. a re-sent waiting status). */
  lastKey: Readonly<Record<string, string>>;
  pending: readonly AlertItem[];
  visible: readonly AlertItem[];
  seq: number;
}
/** Internal windows (ms). */
export const ALERT_LIMITS = { coalesceMs: 1500, pendingMax: 12, pendingTtlMs: 30_000, replayGraceMs: 15_000 } as const;
