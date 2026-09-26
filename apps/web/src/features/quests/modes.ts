import { permissionModeWithin, type RunPermissionMode, type RunnerStatus } from '@tagconn/shared';

/**
 * New-quest mode picker logic (docs/design/runner-and-helpdesk.md section 3: "the mode (only
 * allowedPermissionModes ∩ runner cap ∩ containment, with a one-line explanation each; modes needing
 * a systemd scope are disabled with a tooltip when it is unavailable)"). Kept pure and separate from
 * `NewQuestForm.tsx` so the containment logic (the part most worth getting right) is unit-testable
 * without rendering anything.
 */

export const MODE_EXPLANATIONS: Record<RunPermissionMode, string> = {
  plan: 'Plans only — no edits, no commands.',
  dontAsk: 'Pre-allowed tools only; anything else is refused instead of asked.',
  default: "Claude Code's normal per-tool rules — prompts are disabled headless, so anything not pre-allowed is refused.",
  acceptEdits: 'Edits with pre-allowed tools automatically; shell commands still need the host to allow them.',
  auto: 'Can run shell commands without asking. Needs a systemd user scope on this host.',
  bypassPermissions: 'Skips tool checks entirely. Needs a systemd user scope, and the host must opt in separately.',
};

/** These two can run shell commands with no explicit allow rule, so the runner requires a cgroup kill
 *  (a systemd user scope) to contain them (design doc section 2.3 step 6, "isolation_unavailable"). */
const NEEDS_CONTAINMENT: ReadonlySet<RunPermissionMode> = new Set(['auto', 'bypassPermissions']);

export interface ModeOption {
  mode: RunPermissionMode;
  label: string;
  allowed: boolean;
  /** Why it's disabled — shown as a tooltip. Present only when `allowed` is false. */
  reason?: string;
}

/**
 * `settingsAllowed` (`settings.runner.allowedPermissionModes`) is the starting list; each mode is then
 * narrowed by the connected runner's own cap (`maxPermissionMode`), by whether its capability probe
 * actually accepted the mode, and — for `auto`/`bypassPermissions` — by whether a systemd scope is
 * available at all. With no runner status yet (not connected, or demo mode's own status not loaded),
 * every mode from settings is offered as allowed; the runner itself would still refuse an unsafe one.
 */
export function questModeOptions(settingsAllowed: readonly RunPermissionMode[], status: RunnerStatus | null): ModeOption[] {
  const caps = status?.capabilities;
  const maxMode = status?.maxPermissionMode;
  return settingsAllowed.map((mode) => {
    const label = MODE_EXPLANATIONS[mode];
    if (maxMode && !permissionModeWithin(mode, maxMode)) {
      return { mode, label, allowed: false, reason: `Above the host's local mode cap (${maxMode}).` };
    }
    if (caps && !caps.permissionModes.includes(mode)) {
      return { mode, label, allowed: false, reason: "This Claude CLI version didn't accept this mode when probed." };
    }
    if (NEEDS_CONTAINMENT.has(mode) && caps && !caps.systemdScope) {
      return { mode, label, allowed: false, reason: 'Needs a systemd user scope, which is unavailable on this host.' };
    }
    return { mode, label, allowed: true };
  });
}

/** A registered project's `cwd` (a host realpath) is disabled in the floor picker unless it falls
 *  inside one of the runner's `allowedProjectDirs` — a lexical prefix check mirroring the server's own
 *  (docs/design/runner-and-helpdesk.md section 2.3, "Server-side checks"); the runner re-checks by
 *  realpath regardless, so this is only ever a head start on the UI, never the enforcement. */
export function isProjectDirAllowed(cwd: string, allowedDirs: readonly string[]): boolean {
  return allowedDirs.some((dir) => cwd === dir || cwd.startsWith(dir.endsWith('/') ? dir : `${dir}/`));
}
