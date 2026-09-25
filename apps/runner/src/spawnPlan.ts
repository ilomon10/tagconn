// Combines the pure argv builders (argv.ts, bwrap.ts) into a full `SpawnSpec` (runProcess.ts): the
// systemd-run wrapper for quests that need a cgroup (docs/design/runner-and-helpdesk.md §2.4), and the
// bwrap wrapper for the Receptionist (§4.3).

import { buildBwrapArgv, type BwrapPaths, type MergedUsrDetection } from './bwrap.js';
import { questScopeUnitName, type SpawnSpec } from './runProcess.js';

export interface SystemdScopeOptions {
  memoryMax: string;
  tasksMax: number;
}

/** `systemd-run --user --scope --quiet -p KillMode=control-group -p MemoryMax=<m> -p TasksMax=<n> -- <argv>`. */
export function wrapWithSystemdScope(claudeArgv: readonly string[], runId: string, opts: SystemdScopeOptions): { command: string; args: string[]; scopeUnitName: string } {
  const scopeUnitName = questScopeUnitName(runId);
  const args = [
    '--user',
    '--scope',
    '--quiet',
    `--unit=${scopeUnitName}`,
    '-p',
    'KillMode=control-group',
    '-p',
    `MemoryMax=${opts.memoryMax}`,
    '-p',
    `TasksMax=${opts.tasksMax}`,
    '--',
    ...claudeArgv,
  ];
  return { command: 'systemd-run', args, scopeUnitName: `${scopeUnitName}.scope` };
}

/** `bwrap <binds> --chdir <cwd> -- <argv>`. */
export function wrapWithBwrap(claudeArgv: readonly string[], paths: BwrapPaths, mergedUsr: MergedUsrDetection): { command: string; args: string[] } {
  const bwrapArgv = buildBwrapArgv(paths, mergedUsr);
  // buildBwrapArgv's first element is the literal "bwrap" command name; drop it for the args array.
  const [, ...bwrapArgs] = bwrapArgv;
  return { command: 'bwrap', args: [...bwrapArgs, '--', ...claudeArgv] };
}

export function questSpawnSpec(
  claudeArgv: readonly string[],
  runId: string,
  cwd: string,
  env: Record<string, string>,
  requiresScope: boolean,
  systemd: SystemdScopeOptions,
  stdin?: string,
): SpawnSpec {
  if (requiresScope) {
    const wrapped = wrapWithSystemdScope(claudeArgv, runId, systemd);
    return { command: wrapped.command, args: wrapped.args, cwd, env, wrapper: 'systemd-scope', scopeUnitName: wrapped.scopeUnitName, stdin };
  }
  const [command, ...args] = claudeArgv;
  return { command: command ?? 'claude', args, cwd, env, wrapper: 'plain', stdin };
}

export function receptionistSpawnSpec(
  claudeArgv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  sandboxed: boolean,
  bwrapPaths?: BwrapPaths,
  mergedUsr?: MergedUsrDetection,
  stdin?: string,
): SpawnSpec {
  if (sandboxed && bwrapPaths && mergedUsr) {
    const wrapped = wrapWithBwrap(claudeArgv, bwrapPaths, mergedUsr);
    return { command: wrapped.command, args: wrapped.args, cwd, env, wrapper: 'bwrap', stdin };
  }
  const [command, ...args] = claudeArgv;
  return { command: command ?? 'claude', args, cwd, env, wrapper: 'plain', stdin };
}
