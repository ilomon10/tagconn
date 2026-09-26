// Capability probe (docs/design/runner-and-helpdesk.md §2.1), cached in <stateDir> per claudeVersion.
//
//  - `claude --version` / `--help` detect which flags exist.
//  - Permission modes are probed BY TRYING each RUN_PERMISSION_MODES value once (V8: 2.1.282 accepts
//    all of them, including `default`, which `--help` does not list — so this can't be help-text-only).
//  - stdinPrompt (V9), the sandboxed probe turn (bwrap) and systemdScope are functional probes too.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { RUN_PERMISSION_MODES, type RunnerCapabilities } from '@tagconn/shared';
import { guessTranscriptKey } from './bwrap.js';
import { mapClaudeLine } from './streamParser.js';

const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /**
   * SC5 re-review (HIGH, real-CLI QA): `child_process.spawnSync`'s own error (e.g. ENOENT from a `cwd`
   * that does not exist yet, or from `claudePath` itself being unresolvable) — surfaced explicitly so
   * a caller logging an unexpectedly empty/false probe result can say WHY, instead of silently getting
   * `status: null` and empty stdout/stderr indistinguishable from "the CLI ran and just said no".
   */
  error?: string;
}

/** Injectable so tests can swap in the fake-claude fixture without touching PATH. */
export type Spawn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; input?: string }) => ProbeResult;

export const realSpawn: Spawn = (command, args, opts) => {
  const r = spawnSync(command, args, { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
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
 *
 * SC5 re-review (HIGH, real-CLI QA): `mkdirSync(cwd, ...)` up front is not optional. On a BRAND-NEW
 * runner, `cwd` (`<stateDir>/probe`) does not exist yet the first time this runs — node:child_process
 * fails a nonexistent `cwd` SILENTLY (`status: null`, no thrown error, empty stdout/stderr), which
 * made every mode read as "not accepted" (`acceptedModes: []`) on first boot, while a manual replay
 * (naturally run from an existing directory) looked fine. `verifyTranscriptKeyDerivation` already did
 * this for its own probe turn; this and `probeStdinPrompt` did not.
 */
export function probePermissionModes(spawn: Spawn, claudePath: string, cwd: string, env: NodeJS.ProcessEnv, modes: readonly string[] = RUN_PERMISSION_MODES): string[] {
  mkdirSync(cwd, { recursive: true });
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

/**
 * V9: a flag-looking stdin prompt must stay a prompt (init.permissionMode unchanged, no arg-parse
 * error). SC5 re-review: same `mkdirSync(cwd, ...)` fix as `probePermissionModes` above, and for the
 * same reason (a nonexistent `cwd` silently makes this read `false` on a brand-new runner).
 */
export function probeStdinPrompt(spawn: Spawn, claudePath: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  mkdirSync(cwd, { recursive: true });
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
 * Runs one UNSANDBOXED probe turn in a new unique dir under `probeCwd`, then checks that the CLI
 * created exactly the transcript directory `guessTranscriptKey` predicts for it; a mismatch means the runner's bwrap `--bind` for
 * the transcript dir would target the wrong path, so bwrap must be disabled (falls back to `none`).
 */
export function verifyTranscriptKeyDerivation(spawn: Spawn, claudePath: string, probeCwd: string, claudeProjectsDir: string, env: NodeJS.ProcessEnv): boolean {
  mkdirSync(probeCwd, { recursive: true });
  mkdirSync(claudeProjectsDir, { recursive: true });
  // A fresh, unique cwd: the other probes (and earlier boots) already created a transcript dir for
  // `probeCwd` itself, so a before/after diff on it would never see a new entry.
  const keyCwd = mkdtempSync(join(probeCwd, 'key-'));
  const expected = guessTranscriptKey(keyCwd);
  if (safeReaddir(claudeProjectsDir).includes(expected)) return false;
  spawn(claudePath, ['-p', '--output-format=stream-json', '--verbose', '--setting-sources=user', '--strict-mcp-config', '--permission-mode=plan', '--permission-prompts=none', '--model=haiku'], {
    cwd: keyCwd,
    env,
    input: 'reply with the single word ok',
  });
  // Look for the exact predicted key rather than "the first new dir": another session may create one meanwhile.
  return safeReaddir(claudeProjectsDir).includes(expected);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------- caching

/** Bump when probing logic changes so a cached result from the old logic is re-probed. */
const CAPABILITIES_CACHE_VERSION = 2;

export function capabilitiesCachePath(stateDir: string, claudeVersion: string): string {
  return join(stateDir, `capabilities-v${CAPABILITIES_CACHE_VERSION}-${claudeVersion.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
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
