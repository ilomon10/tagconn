// Platform layer (M11 Wave 1 C, decision #28). Everything OS-specific in the runner goes through an
// injectable `Platform`, so the win32 behaviour is testable on Linux by passing a win32 object.
//
// claude path on Windows (docs/design/desktop.md "Wave 0 results" W0c): `where.exe $PATH:claude` (first PATH hit), then
// %USERPROFILE%\.local\bin\claude.exe. We always resolve to a REAL launch target and never run a
// `.cmd`/`.bat` shim through cmd.exe: the prompt fallback (`-- <prompt>`) and model text would need
// cmd.exe-safe escaping, which is unreliable, and Node itself refuses to spawn a .cmd without a shell.
// A shim is therefore parsed for the target it calls: a native `.exe` (used directly), or node + a
// `cli.js` (launched as `node cli.js ...`). A shim we cannot parse resolves to undefined (fail closed).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface Platform {
  /** process.platform value, e.g. 'win32' | 'linux' | 'darwin'. */
  os: NodeJS.Platform;
  isWin32: boolean;
  /** path.win32 on win32, path.posix elsewhere. */
  path: path.PlatformPath;
  env: NodeJS.ProcessEnv;
  homedir(): string;
  exists(p: string): boolean;
  realpath(p: string): string;
  readText(p: string): string;
  /**
   * Runs a helper binary synchronously (where.exe, sh, taskkill, icacls). Never throws. Always bounded by
   * a timeout (default 10s) and run from a fixed cwd (win32: %SystemRoot%, else `/`), never the caller's cwd.
   */
  run(command: string, args: string[], opts?: RunOptions): { status: number | null; stdout: string };
  /** process.kill, injectable. */
  kill(pid: number, signal: NodeJS.Signals): void;
  /** The node executable used to launch an npm shim's cli.js. */
  nodeExecPath: string;
}

export interface RunOptions {
  timeoutMs?: number;
  cwd?: string;
  /** Extra environment variables for the child (merged over the platform env); for values that must not be on argv. */
  env?: Record<string, string>;
}

const DEFAULT_RUN_TIMEOUT_MS = 10_000;

/** `%SystemRoot%` (falling back to %windir%, then C:\\Windows) from a win32 environment. */
export function systemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot || env.SYSTEMROOT || env.windir || env.WINDIR || 'C:\\Windows';
}

/**
 * Absolute path of a Windows system binary (`where.exe`, `taskkill.exe`, `icacls.exe`, `whoami.exe`,
 * `cmd.exe`) under `%SystemRoot%\System32`. Never a bare name: a planted exe in the cwd or on a
 * user-writable PATH entry must not be run by the runner.
 */
export function win32SystemBin(platform: Platform, name: string): string {
  return platform.path.join(systemRoot(platform.env), 'System32', name);
}

export function currentPlatform(): Platform {
  return makePlatform({});
}

export function makePlatform(overrides: Partial<Platform>): Platform {
  const os = overrides.os ?? process.platform;
  const isWin32 = os === 'win32';
  return {
    os,
    isWin32,
    path: isWin32 ? path.win32 : path.posix,
    env: process.env,
    homedir,
    exists: existsSync,
    realpath: (p) => realpathSync(p),
    readText: (p) => readFileSync(p, 'utf8'),
    run: (command, args, opts) => {
      const env = overrides.env ?? process.env;
      const cwd = opts?.cwd ?? (isWin32 ? systemRoot(env) : '/');
      const r = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: opts?.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, cwd, ...(opts?.env ? { env: { ...env, ...opts.env } } : {}) });
      return { status: r.status, stdout: r.stdout ?? '' };
    },
    kill: (pid, signal) => process.kill(pid, signal),
    nodeExecPath: process.execPath,
    ...overrides,
  };
}

// ------------------------------------------------------------------------------------------ state dir

/** POSIX: $XDG_STATE_HOME/tagconn or ~/.local/state/tagconn. win32: %LOCALAPPDATA%\tagconn\state. */
export function defaultStateDir(platform: Platform = currentPlatform()): string {
  if (platform.isWin32) {
    const local = platform.env.LOCALAPPDATA;
    const base = local && local.trim() !== '' ? local : platform.path.join(platform.homedir(), 'AppData', 'Local');
    return platform.path.join(base, 'tagconn', 'state');
  }
  const xdg = platform.env.XDG_STATE_HOME;
  return xdg && xdg.trim() !== '' ? platform.path.join(xdg, 'tagconn') : platform.path.join(platform.homedir(), '.local', 'state', 'tagconn');
}

// ------------------------------------------------------------------------------------------ claude path

/** What to exec for the claude CLI: `command` plus any fixed leading args (node + cli.js for an npm shim). */
export interface ClaudeLaunch {
  command: string;
  args: string[];
}

/** A `%dp0%\...\target` reference inside an npm-generated `.cmd` shim. */
const SHIM_TARGET_RE = /"%dp0%[\\/]+([^"%]+\.(?:exe|js|mjs|cjs))"/gi;

/** The only shim targets accepted (relative to the shim's dir): npm's cli.js, or the native binary its postinstall drops. */
const SHIM_ALLOWED_REL = ['node_modules\\@anthropic-ai\\claude-code\\cli.js', 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'];

/** Parses an npm `.cmd` shim into a real launch target; undefined when it calls nothing we recognise. */
export function parseCmdShim(shimPath: string, platform: Platform): ClaudeLaunch | undefined {
  let text: string;
  try {
    text = platform.readText(shimPath);
  } catch {
    return undefined;
  }
  const dir = platform.path.dirname(shimPath);
  const targets = [...text.matchAll(SHIM_TARGET_RE)].map((m) => m[1] ?? '').filter(Boolean);
  const target = targets[targets.length - 1];
  if (!target) return undefined;
  // N3: fail closed unless the target is the known claude-code layout INSIDE the shim's own dir tree.
  if (target.split(/[\\/]+/).some((seg) => seg === '..' || seg === '.')) return undefined;
  const abs = platform.path.resolve(dir, target);
  const rel = platform.path.relative(dir, abs);
  if (!rel || rel.startsWith('..') || platform.path.isAbsolute(rel)) return undefined;
  const relNorm = rel.toLowerCase().replace(/\//g, '\\');
  if (!SHIM_ALLOWED_REL.some((a) => relNorm === a)) return undefined;
  if (!platform.exists(abs)) return undefined;
  if (abs.toLowerCase().endsWith('.exe')) return { command: safeRealpath(abs, platform), args: [] };
  const localNode = platform.path.join(dir, 'node.exe');
  const node = platform.exists(localNode) ? localNode : platform.nodeExecPath;
  return { command: node, args: [safeRealpath(abs, platform)] };
}

function safeRealpath(p: string, platform: Platform): string {
  try {
    return platform.realpath(p);
  } catch {
    return p;
  }
}

/**
 * PATH-ORDER lookup (M11 review M2): `where.exe $PATH:claude` searches PATH only (never the cwd, which
 * plain `where.exe claude` also does) and prints hits in PATH order. Only absolute hits with a launchable
 * extension are kept (the extensionless file npm also drops is a sh script). The FIRST hit wins; a later
 * .exe never overrides an earlier .cmd shim. %USERPROFILE%\.local\bin\claude.exe is the fallback when
 * PATH has nothing.
 */
function winCandidates(claudePath: string, platform: Platform): string[] {
  const found: string[] = [];
  if (platform.path.isAbsolute(claudePath)) {
    found.push(claudePath);
  } else {
    const r = platform.run(win32SystemBin(platform, 'where.exe'), [`$PATH:${claudePath}`], { timeoutMs: 10_000, cwd: systemRoot(platform.env) });
    if (r.status === 0) found.push(...r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const profile = platform.env.USERPROFILE ?? platform.homedir();
    found.push(platform.path.join(profile, '.local', 'bin', 'claude.exe'));
  }
  return found;
}

function resolveWin32(claudePath: string, platform: Platform): ClaudeLaunch | undefined {
  const ext = (c: string) => platform.path.extname(c).toLowerCase();
  const launchable = winCandidates(claudePath, platform).filter(
    (c) => platform.path.isAbsolute(c) && ['.exe', '.cmd', '.bat'].includes(ext(c)) && platform.exists(c),
  );
  const first = launchable[0];
  if (!first) return undefined;
  if (ext(first) === '.exe') return { command: safeRealpath(first, platform), args: [] };
  return parseCmdShim(first, platform);
}

function resolvePosix(claudePath: string, platform: Platform): ClaudeLaunch | undefined {
  let found: string | undefined;
  if (platform.path.isAbsolute(claudePath)) {
    found = claudePath;
  } else {
    const r = platform.run('sh', ['-c', 'command -v -- "$1"', 'sh', claudePath]);
    found = r.stdout.trim();
    if (r.status !== 0 || !found) return undefined;
  }
  try {
    return { command: platform.realpath(found), args: [] };
  } catch {
    return undefined;
  }
}

export function resolveClaudeLaunch(claudePath: string, platform: Platform = currentPlatform()): ClaudeLaunch | undefined {
  return platform.isWin32 ? resolveWin32(claudePath, platform) : resolvePosix(claudePath, platform);
}

// ------------------------------------------------------------------------------------------ process control

/** win32: `taskkill /PID <pid> /T /F` (whole tree, no graceful phase). */
export function taskkillArgs(pid: number): string[] {
  return ['/PID', String(pid), '/T', '/F'];
}

/**
 * Kills the process tree rooted at `pid`. win32 uses taskkill (the `signal` is ignored: there is no
 * graceful signal for a console child); POSIX signals the process group when `group` (the child was
 * spawned detached), else the pid itself. Never throws.
 */
export function killTree(pid: number, opts: { platform?: Platform; signal: NodeJS.Signals; group: boolean }): void {
  const platform = opts.platform ?? currentPlatform();
  if (platform.isWin32) {
    platform.run(win32SystemBin(platform, 'taskkill.exe'), taskkillArgs(pid), { timeoutMs: 10_000 });
    return;
  }
  try {
    platform.kill(opts.group ? -pid : pid, opts.signal);
  } catch {
    /* already gone */
  }
}

/** child_process.spawn options that differ per OS: no process group on win32, and no console window. */
export function childSpawnOptions(platform: Platform, wantGroup: boolean): { detached: boolean; windowsHide: boolean } {
  return { detached: !platform.isWin32 && wantGroup, windowsHide: platform.isWin32 };
}

/** win32 has no systemd user scope and no bubblewrap: those probes must never be spawned there. */
export function hasLinuxIsolation(platform: Platform): boolean {
  return !platform.isWin32;
}
