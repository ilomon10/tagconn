import type { RunnerStatus } from '@tagconn/shared';

/**
 * Pure "which banner" decision for `RunnerStatusBanner.tsx` and `QuestBoard.tsx`'s empty/error
 * states, extracted so the precedence (docs/design/runner-and-helpdesk.md section 3: "connected/
 * capabilities/offline → guidance; disabled → guidance") is unit-testable without rendering
 * anything. Same order the banner always checked: a disabled runner wins even over a stale
 * "connected" status, and a missing capability outranks a plain "connected" banner because a run
 * would still be refused despite the green dot.
 */
export type RunnerBannerState =
  | { kind: 'disabled' }
  | { kind: 'offline' }
  | { kind: 'capability_missing' }
  | { kind: 'ok'; activeRuns: number; queuedRuns: number; maxConcurrent: number; noSystemdScope: boolean };

export function runnerBannerState(input: { demo: boolean; enabled: boolean; status: RunnerStatus | null }): RunnerBannerState {
  const { demo, enabled, status } = input;
  if (!demo && !enabled) return { kind: 'disabled' };
  if (!status || !status.connected || !status.verified) return { kind: 'offline' };
  const caps = status.capabilities;
  if (caps && (!caps.settingSources || !caps.strictMcpConfig || !caps.permissionPrompts)) return { kind: 'capability_missing' };
  return {
    kind: 'ok',
    activeRuns: status.activeRuns,
    queuedRuns: status.queuedRuns,
    maxConcurrent: status.maxConcurrent,
    noSystemdScope: !!(caps && !caps.systemdScope),
  };
}

/** Shared with `ReceptionistPanel.tsx`'s runner-offline messaging (both point at the same guide page). */
export const RUNNER_AND_QUESTS_GUIDE_URL = 'https://github.com/ilomon10/tagconn/blob/main/docs/guide/runner-and-quests.md';

/** The exact command the guide tells the user to run; kept as one constant so the banner text and its
 *  copy button never drift apart. */
export const RUNNER_START_COMMAND = 'pnpm office:runner';
