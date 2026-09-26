// The full runner-side validation pipeline for a quest `run:start` (docs/design/runner-and-helpdesk.md
// §2.3, steps 2-7; step 1 schema and step 8 concurrency are checked by the caller). Composed from
// trust.ts (dir/trust) and toolPolicy.ts (mode/tools/containment) plus the resume ledger.

import { absoluteRulePath, type RunEndReason, type RunnerCapabilities, type RunnerLocalConfig, type RunPermissionMode } from '@tagconn/shared';
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
  /** SC5 H2: the exact `--tools` list to pass (see toolPolicy.ts's checkQuestPolicy). */
  toolSet: string[];
  /** Fingerprint to record in the ledger once the run's session id is known (init event). */
  fingerprint: string;
}

export interface QuestValidationFail {
  ok: false;
  failure: RunEndReason;
}

export function validateQuestStart(
  input: QuestValidationInput,
  cfg: Pick<RunnerLocalConfig, 'allowedProjectDirs' | 'trustOverrideDirs' | 'maxPermissionMode' | 'allowBypassPermissions' | 'questToolPolicy' | 'processIsolation'> & {
    /** SC5 M1: appended as an Edit/Write/MultiEdit/NotebookEdit deny for this exact absolute path,
     *  since it cannot be a static DEFAULT_QUEST_ALWAYS_DENY entry (stateDir is host-configurable and
     *  is not always under $HOME). */
    stateDir: string;
  },
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

  // M1: the runner's own stateDir (ledger, per-run disposable files, receptionist docs copy) is never
  // an editable quest target, even if it happens to fall under an allowed project dir. R2 (SC5
  // re-review): a rule glob's leading `/` is relative to the settings source, not the filesystem root
  // — `absoluteRulePath` doubles it (`//home/...`) so this deny actually matches the absolute stateDir
  // instead of silently matching nothing (see its doc in packages/shared/src/runner.ts).
  const stateDirDeny = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].map((tool) => `${tool}(${absoluteRulePath(cfg.stateDir)}/**)`);
  const disallowedTools = Array.from(new Set([...policy.disallowedTools, ...stateDirDeny]));

  return { ok: true, realDir, disallowedTools, requiresScope: policy.requiresScope, toolSet: policy.toolSet, fingerprint };
}
