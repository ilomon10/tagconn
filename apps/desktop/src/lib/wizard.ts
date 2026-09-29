import type { InstallResult, ServiceStatus, SetupCheck } from '@tagconn/shared';

export const WIZARD_STEPS = ['welcome', 'check', 'folders', 'hooks', 'start', 'done'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const STEP_TITLES: Record<WizardStep, string> = {
  welcome: 'Welcome',
  check: 'System check',
  folders: 'Runner folders',
  hooks: 'Install hooks',
  start: 'Start services',
  done: 'Done',
};

/** True when one of our own services holds the server port (a re-check then sees the port as busy). */
export function ownServerRunning(services: Partial<Record<string, ServiceStatus>>): boolean {
  return services.server?.state === 'running' || services.docker?.state === 'running';
}

/**
 * Required checks that failed: they block everything after the System check. `server_port` never blocks
 * while our own server runs on it (the port is busy because of us).
 */
export function blockingChecks(checks: SetupCheck[] | null, ownRunning = false): SetupCheck[] {
  return (checks ?? []).filter((c) => c.required && c.status === 'fail' && !(ownRunning && c.id === 'server_port'));
}

export interface WizardGate {
  checks: SetupCheck[] | null;
  /** True while a check run is in flight. */
  checking: boolean;
  installResult: InstallResult | null;
  services: Partial<Record<string, ServiceStatus>>;
}

/** Can the user leave `step` forward? Pure, so the gating is unit-tested. */
export function canAdvance(step: WizardStep, g: WizardGate): boolean {
  switch (step) {
    case 'welcome':
    case 'folders':
      return true;
    case 'check':
      return g.checks !== null && !g.checking && blockingChecks(g.checks, ownServerRunning(g.services)).length === 0;
    case 'hooks': {
      // Explicit consent: either the user pressed Install (result present) or the hooks are already installed.
      const already = g.checks?.find((c) => c.id === 'hooks')?.status === 'ok';
      return g.installResult !== null || Boolean(already);
    }
    case 'start':
      return g.services.server?.state === 'running' || g.services.docker?.state === 'running';
    case 'done':
      return false;
  }
}

export function nextStep(step: WizardStep): WizardStep {
  return WIZARD_STEPS[Math.min(WIZARD_STEPS.indexOf(step) + 1, WIZARD_STEPS.length - 1)] ?? 'done';
}
export function prevStep(step: WizardStep): WizardStep {
  return WIZARD_STEPS[Math.max(WIZARD_STEPS.indexOf(step) - 1, 0)] ?? 'welcome';
}

/**
 * Only until setup has completed once. Failed checks later never switch back to the wizard (that would
 * hide the Stop buttons); the panel shows them as a banner and "Run setup again" reopens the wizard.
 */
export function needsWizard(setupDone: boolean): boolean {
  return !setupDone;
}

/** Checks the panel banner lists: blocking failures (with fixes), ignoring our own port. */
export function bannerChecks(setupDone: boolean, checks: SetupCheck[] | null, services: Partial<Record<string, ServiceStatus>>): SetupCheck[] {
  return setupDone ? blockingChecks(checks, ownServerRunning(services)) : [];
}

/** What the check list shows: our own server holding the port is fine, not a failure. */
export function displayCheck(c: SetupCheck, ownRunning: boolean): SetupCheck {
  if (c.id === 'server_port' && c.status === 'fail' && ownRunning) return { ...c, status: 'ok', detail: "In use by tagconn's own server (OK)." };
  return c;
}

/** Aggregate of the check list for the summary line. */
export function summarizeChecks(checks: SetupCheck[]): { ok: number; warn: number; fail: number } {
  return {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };
}
