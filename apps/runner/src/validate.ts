// The full runner-side validation pipeline for a quest `run:start` (docs/design/runner-and-helpdesk.md
// §2.3, steps 2-7; step 1 schema and step 8 concurrency are checked by the caller). Composed from
// trust.ts (dir/trust) and toolPolicy.ts (mode/tools/containment) plus the resume ledger.

import type { RunEndReason, RunnerCapabilities, RunnerLocalConfig, RunPermissionMode } from '@tagconn/shared';
import { canResume, computeFingerprint, type Ledger } from './ledger.js';
import { checkQuestPolicy } from './toolPolicy.js';
import { checkAllowedDir, isTrustedDir } from './trust.js';

export interface QuestValidationInput {
  projectDir: string;
  permissionMode: RunPermissionMode;
  allowedTools: readonly string[];
  disallowedTools: readonly string[];
  resumeSessionId?: string;
}

export interface QuestValidationOk {
  ok: true;
  realDir: string;
  disallowedTools: string[];
  requiresScope: boolean;
  /** Fingerprint to record in the ledger once the run's session id is known (init event). */
  fingerprint: string;
}

export interface QuestValidationFail {
  ok: false;
  failure: RunEndReason;
}

export function validateQuestStart(
  input: QuestValidationInput,
  cfg: Pick<RunnerLocalConfig, 'allowedProjectDirs' | 'trustOverrideDirs' | 'maxPermissionMode' | 'allowBypassPermissions' | 'questToolPolicy' | 'processIsolation'>,
  caps: Pick<RunnerCapabilities, 'permissionModes' | 'systemdScope'>,
  claudeJsonPath: string,
  ledger: Ledger,
): QuestValidationOk | QuestValidationFail {
  // 2. Dir.
  const dirCheck = checkAllowedDir(input.projectDir, cfg.allowedProjectDirs);
  if (!dirCheck.ok || !dirCheck.realDir) return { ok: false, failure: 'dir_not_allowed' };
  const realDir = dirCheck.realDir;

  // 3. Trust.
  if (!isTrustedDir(realDir, { claudeJsonPath, trustOverrideDirs: cfg.trustOverrideDirs })) {
    return { ok: false, failure: 'dir_not_trusted' };
  }

  // 4-6. Mode, tools, containment.
  const systemdScopeAvailable = cfg.processIsolation !== 'none' && caps.systemdScope;
  const policy = checkQuestPolicy(
    { mode: input.permissionMode, allowedTools: input.allowedTools, availablePermissionModes: caps.permissionModes },
    {
      maxPermissionMode: cfg.maxPermissionMode,
      allowBypassPermissions: cfg.allowBypassPermissions,
      questToolPolicy: cfg.questToolPolicy,
      systemdScopeAvailable,
    },
    input.disallowedTools,
  );
  if (!policy.ok) return { ok: false, failure: policy.failure };

  // 7. Resume: only a session id THIS runner created, with an unchanged fingerprint (fail-closed, V15).
  const fingerprint = computeFingerprint({ tools: input.allowedTools, mode: input.permissionMode, restricted: false, safeMode: false });
  if (input.resumeSessionId && !canResume(ledger, input.resumeSessionId, fingerprint)) {
    return { ok: false, failure: 'resume_not_allowed' };
  }

  return { ok: true, realDir, disallowedTools: policy.disallowedTools, requiresScope: policy.requiresScope, fingerprint };
}
