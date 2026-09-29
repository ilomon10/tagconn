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

/** Required checks that failed: they block everything after the System check. */
export function blockingChecks(checks: SetupCheck[] | null): SetupCheck[] {
  return (checks ?? []).filter((c) => c.required && c.status === 'fail');
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
      return g.checks !== null && !g.checking && blockingChecks(g.checks).length === 0;
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

/** First run, or a required check fails: show the wizard instead of the control panel. */
export function needsWizard(setupDone: boolean, checks: SetupCheck[] | null): boolean {
  return !setupDone || blockingChecks(checks).length > 0;
}

/** Aggregate of the check list for the summary line. */
export function summarizeChecks(checks: SetupCheck[]): { ok: number; warn: number; fail: number } {
  return {
    ok: checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };
}
