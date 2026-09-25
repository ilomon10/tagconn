// Capability probe (docs/design/runner-and-helpdesk.md §2.1), cached in <stateDir> per claudeVersion.
//
//  - `claude --version` / `--help` detect which flags exist.
//  - Permission modes are probed BY TRYING each RUN_PERMISSION_MODES value once (V8: 2.1.282 accepts
//    all of them, including `default`, which `--help` does not list — so this can't be help-text-only).
//  - stdinPrompt (V9), the sandboxed probe turn (bwrap) and systemdScope are functional probes too.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { RUN_PERMISSION_MODES, type RunnerCapabilities } from '@tagconn/shared';
import { guessTranscriptKey } from './bwrap.js';
import { mapClaudeLine } from './streamParser.js';

const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable so tests can swap in the fake-claude fixture without touching PATH. */
export type Spawn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string }) => ProbeResult;

export const realSpawn: Spawn = (command, args, opts) => {
  const r = spawnSync(command, args, { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// ---------------------------------------------------------------------------------------- help / version

const HELP_FLAG_CHECKS: Record<
  keyof Pick<
    RunnerCapabilities,
    'tools' | 'restricted' | 'safeMode' | 'permissionPrompts' | 'disableSlashCommands' | 'strictMcpConfig' | 'settingSources' | 'includePartialMessages'
  >,
  string
> = {
  tools: '--tools',
  restricted: '--restricted',
  safeMode: '--safe-mode',
  permissionPrompts: '--permission-prompts',
  disableSlashCommands: '--disable-slash-commands',
  strictMcpConfig: '--strict-mcp-config',
  settingSources: '--setting-sources',
  includePartialMessages: '--include-partial-messages',
};

export function parseHelpFlags(helpText: string) {
  const out = {} as Record<keyof typeof HELP_FLAG_CHECKS, boolean>;
  for (const [key, flag] of Object.entries(HELP_FLAG_CHECKS)) {
    out[key as keyof typeof HELP_FLAG_CHECKS] = helpText.includes(flag);
  }
  return out;
}

export function parseVersion(versionText: string): string {
  const m = versionText.trim().match(/(\d+\.\d+\.\d+)/);
  return m?.[1] ?? versionText.trim();
}

/**
 * Resolves `runner.json`'s `claudePath` (a bare PATH-relative name, or an absolute path) to a real,
 * symlink-free absolute path. Needed for the bwrap `--ro-bind` of the CLI's own directory (§4.3):
 * `--ro-bind "$(dirname "$(readlink -f "$claudePath")")"`. Returns undefined if it can't be resolved.
 */
export function resolveClaudePath(claudePath: string): string | undefined {
  if (isAbsolute(claudePath)) {
    try {
      return realpathSync(claudePath);
    } catch {
      return undefined;
    }
  }
  const r = spawnSync('sh', ['-c', `command -v -- "$1"`, 'sh', claudePath], { encoding: 'utf8' });
  const found = r.stdout?.trim();
  if (r.status !== 0 || !found) return undefined;
  try {
    return realpathSync(found);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------- permission modes

/**
 * Probes each mode once with a trivial turn (V8: probe by trying). A mode is "accepted" if the
 * process exits 0; the CLI hard-fails (non-zero) on a mode it does not recognize.
 */
export function probePermissionModes(spawn: Spawn, claudePath: string, cwd: string, env: NodeJS.ProcessEnv, modes: readonly string[] = RUN_PERMISSION_MODES): string[] {
  const accepted: string[] = [];
  for (const mode of modes) {
    const r = spawn(
      claudePath,
      [
        '-p',
        '--output-format=stream-json',
        '--verbose',
        '--setting-sources=user',
        '--strict-mcp-config',
        `--permission-mode=${mode}`,
        '--permission-prompts=none',
        '--model=haiku',
      ],
      { cwd, env, input: 'reply with the single word ok' },
    );
    if (r.status === 0) accepted.push(mode);
  }
  return accepted;
}

/** V9: a flag-looking stdin prompt must stay a prompt (init.permissionMode unchanged, no arg-parse error). */
export function probeStdinPrompt(spawn: Spawn, claudePath: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  const requestedMode = 'plan';
  const r = spawn(
    claudePath,
    ['-p', '--output-format=stream-json', '--verbose', '--setting-sources=user', '--strict-mcp-config', `--permission-mode=${requestedMode}`, '--permission-prompts=none', '--model=haiku'],
    { cwd, env, input: '--dangerously-skip-permissions hi' },
  );
  if (r.status !== 0) return false;
  for (const line of r.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const events = mapClaudeLine(JSON.parse(trimmed), 2_000);
      const init = events.find((e) => e.kind === 'init');
      if (init && init.kind === 'init') return init.permissionMode === requestedMode || init.permissionMode === undefined;
    } catch {
      /* not JSON, ignore */
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------- systemd scope

export function probeSystemdScope(spawn: Spawn = realSpawn): boolean {
  const r = spawn('systemd-run', ['--user', '--scope', '--quiet', '--', 'true'], { cwd: '/', env: process.env });
  return r.status === 0;
}

// ---------------------------------------------------------------------------------------- bwrap / merged-usr / transcript key

export function bwrapAvailable(spawn: Spawn = realSpawn): boolean {
  const r = spawn('bwrap', ['--version'], { cwd: '/', env: process.env });
  return r.status === 0;
}

/**
 * Runs one UNSANDBOXED probe turn in `probeCwd` (a fresh scratch dir under stateDir), then diffs
 * `<claudeProjectsDir>` before/after to find the transcript directory the CLI actually created.
 * Compares it with `guessTranscriptKey(probeCwd)`; a mismatch means the runner's bwrap `--bind` for
 * the transcript dir would target the wrong path, so bwrap must be disabled (falls back to `none`).
 */
export function verifyTranscriptKeyDerivation(spawn: Spawn, claudePath: string, probeCwd: string, claudeProjectsDir: string, env: NodeJS.ProcessEnv): boolean {
  mkdirSync(probeCwd, { recursive: true });
  mkdirSync(claudeProjectsDir, { recursive: true });
  const before = new Set(safeReaddir(claudeProjectsDir));
  spawn(claudePath, ['-p', '--output-format=stream-json', '--verbose', '--setting-sources=user', '--strict-mcp-config', '--permission-mode=plan', '--permission-prompts=none', '--model=haiku'], {
    cwd: probeCwd,
    env,
    input: 'reply with the single word ok',
  });
  const after = safeReaddir(claudeProjectsDir);
  const created = after.find((d) => !before.has(d));
  if (!created) return false;
  return created === guessTranscriptKey(probeCwd);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------- caching

export function capabilitiesCachePath(stateDir: string, claudeVersion: string): string {
  return join(stateDir, `capabilities-${claudeVersion.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

export function loadCachedCapabilities(stateDir: string, claudeVersion: string): RunnerCapabilities | undefined {
  const path = capabilitiesCachePath(stateDir, claudeVersion);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RunnerCapabilities;
  } catch {
    return undefined;
  }
}

export function saveCachedCapabilities(stateDir: string, claudeVersion: string, caps: RunnerCapabilities): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(capabilitiesCachePath(stateDir, claudeVersion), JSON.stringify(caps, null, 2));
}

/** Removes a stale probe scratch dir; capability probing creates one under `<stateDir>/probe`. */
export function cleanupProbeDir(stateDir: string): void {
  rmSync(join(stateDir, 'probe'), { recursive: true, force: true });
}
