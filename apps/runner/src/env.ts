// Spawn environment builder (docs/design/runner-and-helpdesk.md §2.4). The server NEVER supplies env;
// this is built entirely from the runner's own process.env plus runner.json's `passEnv`.

import { RUN_ENV, RUN_ENV_BASE_ALLOWLIST, RUN_ENV_STRIP_PREFIXES, type RunKind } from '@tagconn/shared';

function isStripped(name: string): boolean {
  return RUN_ENV_STRIP_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function isLcOrXdg(name: string): boolean {
  return name.startsWith('LC_') || name.startsWith('XDG_');
}

export interface BuildRunEnvInput {
  runId: string;
  runKind: RunKind;
  passEnv: readonly string[];
  /** Receptionist runs set TAGCONN_ATTRIBUTION=off so the hook (if it ran at all) skips attribution work. */
  attributionOff?: boolean;
  /** Injectable for tests; defaults to process.env. */
  sourceEnv?: NodeJS.ProcessEnv;
}

/**
 * Base allowlist + LC_ and XDG prefixed vars + runner.json passEnv, minus RUN_ENV_STRIP_PREFIXES
 * (which win even if a name is also in passEnv), plus TAGCONN_RUN_ID / TAGCONN_RUN_KIND (and
 * TAGCONN_ATTRIBUTION for the Receptionist).
 */
export function buildRunEnv(input: BuildRunEnvInput): Record<string, string> {
  const src = input.sourceEnv ?? process.env;
  const allowedNames = new Set<string>([...RUN_ENV_BASE_ALLOWLIST, ...input.passEnv]);

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(src)) {
    if (value === undefined) continue;
    if (isStripped(name)) continue;
    if (allowedNames.has(name) || isLcOrXdg(name)) env[name] = value;
  }

  env[RUN_ENV.runId] = input.runId;
  env[RUN_ENV.runKind] = input.runKind;
  if (input.attributionOff) env[RUN_ENV.attribution] = 'off';
  return env;
}
