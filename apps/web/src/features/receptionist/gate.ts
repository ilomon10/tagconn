import type { RunnerStatus } from '@tagconn/shared';

/**
 * Pure "which state" decisions for `ReceptionistPanel.tsx`, extracted the same way
 * `features/quests/runnerBannerState.ts` extracts the Quest board's banner precedence — so both are
 * unit-tested without rendering anything.
 *
 * Two separate gates because they answer different questions: `receptionistPanelGate` is "can this
 * browser see the panel at all" (loading settings, disabled in settings, not paired), while
 * `receptionistSendGate` is "can a new turn start right now" (also needs a connected runner with the
 * required capabilities) — a paired admin can still browse old conversations while the runner is
 * offline, only *sending* is blocked.
 */
export type ReceptionistPanelGate = 'loading' | 'disabled' | 'not_paired' | 'ready';

/** `authLoaded` = the auth status round trip has answered; until then a not-yet-admin browser shows
 *  'loading', not 'not_paired' (a paired browser would otherwise flash "Pair this browser" on reload). */
export function receptionistPanelGate(input: { settingsLoaded: boolean; allowed: boolean; receptionistEnabled: boolean; authLoaded?: boolean }): ReceptionistPanelGate {
  if (!input.settingsLoaded) return 'loading';
  if (!input.receptionistEnabled) return 'disabled';
  if (!input.allowed) return input.authLoaded === false ? 'loading' : 'not_paired';
  return 'ready';
}

export type ReceptionistSendGate = 'not_paired' | 'disabled' | 'runner_offline' | 'capability_missing' | 'ready';

/**
 * `demo` short-circuits straight to `ready` (matching the panel's existing demo behavior: there is no
 * real runner to be offline, and `sendMessage` itself no-ops in demo mode regardless). `runnerStatus`
 * being `null` (not fetched yet) is treated as "unknown" rather than "offline" — sending stays enabled
 * until the fetch actually reports a disconnected runner, the same optimism `setSocketAuthGate` uses
 * for admin status before it's loaded.
 */
export function receptionistSendGate(input: {
  demo: boolean;
  allowed: boolean;
  receptionistEnabled: boolean;
  runnerStatus: RunnerStatus | null;
}): ReceptionistSendGate {
  if (!input.allowed) return 'not_paired';
  if (!input.receptionistEnabled) return 'disabled';
  if (input.demo) return 'ready';
  const status = input.runnerStatus;
  if (status !== null && !status.connected) return 'runner_offline';
  const caps = status?.capabilities;
  if (caps && (!caps.settingSources || !caps.strictMcpConfig || !caps.permissionPrompts || !caps.tools)) return 'capability_missing';
  return 'ready';
}
