import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir as osHomedir } from 'node:os';
import { pathFor } from './paths.ts';
import { defaultExec, type ExecFn, type ExecResult } from './secrets.ts';
import { HOOK_EVENTS, SettingsParseError, summarizeHooks } from './claudeSettings.ts';
import type { SetupCheck } from './types.ts';

export type BindResult = { ok: true } | { ok: false; code: string; message: string };

/** Everything a check touches outside its own arguments, so each check is mockable. */
export interface CheckDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir: string;
  exec: ExecFn;
  exists: (path: string) => boolean;
  /** Tries to listen on 127.0.0.1:<port> and releases it again. */
  bindPort: (port: number) => Promise<BindResult>;
  /** Creates `dir` and writes + removes a probe file in it; throws with the OS error on failure. */
  writeTest: (dir: string) => void;
  /** Throws if `path` cannot be opened for writing (a locked settings.json). */
  assertWritable: (path: string) => void;
  readFile: (path: string) => string;
  /** True if `path` exists and can be executed (win32: exists). Default: exists. */
  isExecutable?: (path: string) => boolean;
}

export function defaultCheckDeps(): CheckDeps {
  return {
    platform: process.platform,
    env: process.env,
    homedir: osHomedir(),
    exec: defaultExec,
    exists: existsSync,
    bindPort: (port) =>
      new Promise((resolve) => {
        const srv = createServer();
        srv.once('error', (err: NodeJS.ErrnoException) => resolve({ ok: false, code: err.code ?? 'UNKNOWN', message: err.message }));
        srv.listen(port, '127.0.0.1', () => srv.close(() => resolve({ ok: true })));
      }),
    writeTest: (dir) => {
      mkdirSync(dir, { recursive: true });
      const probe = pathFor(process.platform).join(dir, `.tagconn-write-test-${process.pid}`);
      writeFileSync(probe, 'ok');
      rmSync(probe, { force: true });
    },
    assertWritable: (path) => accessSync(path, constants.W_OK),
    readFile: (path) => readFileSync(path, 'utf8'),
    isExecutable: (path) => {
      try {
        accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export const CLAUDE_INSTALL_URL = 'https://docs.claude.com/en/docs/claude-code/setup';
export const GIT_FOR_WINDOWS_URL = 'https://git-scm.com/download/win';

// ---------------------------------------------------------------------------
// claude CLI
// ---------------------------------------------------------------------------

export interface ClaudeLocation {
  path: string;
  version: string | null;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
}

/**
 * Absolute entries of PATH, in PATH order (a relative entry, "." or an empty one would search the current
 * directory, where a planted claude.exe could win, so it is dropped).
 */
function pathEntries(deps: CheckDeps): string[] {
  const p = pathFor(deps.platform);
  const raw = deps.platform === 'win32' ? (deps.env.Path ?? deps.env.PATH ?? deps.env.path ?? '') : (deps.env.PATH ?? '');
  const sep = deps.platform === 'win32' ? ';' : ':';
  return raw
    .split(sep)
    .map((e) => (deps.platform === 'win32' ? e.trim().replace(/^"(.*)"$/, '$1') : e))
    .filter((e) => e !== '' && p.isAbsolute(e));
}

/** Windows: every `<name>.exe|.cmd|.bat` on PATH, PATH order (no cwd), so `where.exe` (which searches the cwd first) is not needed. */
export function findOnWindowsPath(deps: CheckDeps, name: string): string[] {
  const p = pathFor('win32');
  const hits: string[] = [];
  for (const dir of pathEntries(deps)) {
    for (const ext of ['.exe', '.cmd', '.bat']) {
      const candidate = p.join(dir, name + ext);
      if (deps.exists(candidate)) hits.push(candidate);
    }
  }
  return hits;
}

/**
 * Reads an npm-generated `.cmd` shim and returns what it launches, without going through cmd.exe: the
 * target `.exe`, or `node <target.js>` (node from the shim's own dir, else PATH). null if it can't be parsed
 * or looks unsafe. A duplicate of the parser in apps/runner (setup can't import it).
 */
export function parseNpmShim(deps: CheckDeps, shimPath: string): { cmd: string; prefix: string[] } | null {
  const p = pathFor('win32');
  let text: string;
  try {
    text = deps.readFile(shimPath);
  } catch {
    return null;
  }
  const dir = p.dirname(shimPath);
  const re = /"%(?:dp0%|~dp0)[\\/]+([^"%\r\n]+)"/gi;
  let target: string | null = null;
  for (const m of text.matchAll(re)) {
    const rel = m[1] as string;
    if (/(^|[\\/])node\.exe$/i.test(rel)) continue;
    // Never follow a `..` out of the shim's directory tree.
    if (rel.split(/[\\/]+/).includes('..')) return null;
    target = p.resolve(dir, rel);
    break;
  }
  if (!target) return null;
  // The target must stay inside the shim's own dir and be the Claude Code package's cli.js or a binary inside it.
  const relToDir = p.relative(dir.toLowerCase(), target.toLowerCase());
  if (relToDir === '' || relToDir.startsWith('..') || p.isAbsolute(relToDir)) return null;
  const pkg = /(^|[\\/])node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]/i;
  if (!pkg.test(relToDir)) return null;
  if (/\.exe$/i.test(target)) return { cmd: target, prefix: [] };
  if (!/[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js$/i.test(target)) return null;
  const local = p.join(dir, 'node.exe');
  const node = deps.exists(local) ? local : findOnWindowsPath(deps, 'node').find((c) => /\.exe$/i.test(c));
  return node ? { cmd: node, prefix: [target] } : null;
}

/** Runs `claude <args>`; a Windows `.cmd` shim is parsed and its target run directly (never `cmd.exe /c <path>`). */
export function runClaude(deps: CheckDeps, claudePath: string, args: string[], timeoutMs = 15_000): ExecResult {
  if (deps.platform === 'win32' && /\.(cmd|bat)$/i.test(claudePath)) {
    const shim = parseNpmShim(deps, claudePath);
    if (!shim) {
      return { status: null, stdout: '', stderr: '', error: new Error(`could not read the npm shim ${claudePath}; reinstall Claude Code with the native installer`) };
    }
    return deps.exec(shim.cmd, [...shim.prefix, ...args], { timeoutMs });
  }
  return deps.exec(claudePath, args, { timeoutMs });
}

/** `command -v claude` on POSIX, PATH order (absolute entries only) on win32, then the native install path. */
export function findClaude(deps: CheckDeps): string | null {
  const p = pathFor(deps.platform);
  if (deps.platform === 'win32') {
    const lines = findOnWindowsPath(deps, 'claude');
    // The runner's rule: the FIRST PATH hit (.exe or .cmd/.bat) wins; a later .exe never overrides an earlier shim.
    if (lines[0]) return lines[0];
    const native = p.join(deps.env.USERPROFILE || deps.homedir, '.local', 'bin', 'claude.exe');
    return deps.exists(native) ? native : null;
  }
  const res = deps.exec('sh', ['-c', 'command -v claude'], { timeoutMs: 5000 });
  if (!res.error && res.status === 0 && firstLine(res.stdout)) return firstLine(res.stdout);
  const native = p.join(deps.homedir, '.local', 'bin', 'claude');
  return deps.exists(native) ? native : null;
}

export function locateClaude(deps: CheckDeps): ClaudeLocation | null {
  const path = findClaude(deps);
  if (!path) return null;
  const res = runClaude(deps, path, ['--version']);
  const version = !res.error && res.status === 0 ? firstLine(res.stdout) || null : null;
  return { path, version };
}

function versionAtLeast(found: string, min: string): boolean {
  const num = (v: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1, 4) ?? ['0', '0', '0']).map(Number);
  const a = num(found);
  const b = num(min);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

export function checkClaudeCli(deps: CheckDeps, opts: { minVersion?: string } = {}): SetupCheck {
  const title = 'Claude Code CLI';
  const loc = locateClaude(deps);
  const install = { label: 'Install Claude Code', action: 'open_url' as const, target: CLAUDE_INSTALL_URL };
  if (!loc) {
    return {
      id: 'claude_cli',
      title,
      status: 'fail',
      // Observer mode (hooks + the office) works without the runner, so this never blocks the wizard.
      required: false,
      detail: 'The `claude` command was not found. Quests and the Receptionist need it; watching sessions does not.',
      fix: install,
    };
  }
  if (!loc.version) {
    return {
      id: 'claude_cli',
      title,
      status: 'fail',
      required: false,
      detail: `Found ${loc.path} but \`claude --version\` failed. Reinstall Claude Code.`,
      fix: install,
    };
  }
  if (opts.minVersion && !versionAtLeast(loc.version, opts.minVersion)) {
    return {
      id: 'claude_cli',
      title,
      status: 'fail',
      required: false,
      detail: `claude ${loc.version} at ${loc.path} is older than ${opts.minVersion}. Update Claude Code.`,
      fix: install,
    };
  }
  return { id: 'claude_cli', title, status: 'ok', required: false, detail: `claude ${loc.version} found at ${loc.path}` };
}

export function checkClaudeLogin(deps: CheckDeps): SetupCheck {
  const title = 'Claude login';
  const path = findClaude(deps);
  if (!path) {
    return { id: 'claude_login', title, status: 'skip', required: false, detail: 'Skipped: the Claude CLI was not found.' };
  }
  const res = runClaude(deps, path, ['auth', 'status']);
  if (!res.error && res.status === 0) {
    return { id: 'claude_login', title, status: 'ok', required: false, detail: 'Claude Code is logged in.' };
  }
  return {
    id: 'claude_login',
    title,
    status: 'fail',
    required: false,
    detail: 'Claude Code is not logged in. Run `claude` once in a terminal and log in.',
    fix: { label: 'Re-check', action: 'recheck' },
  };
}

// ---------------------------------------------------------------------------
// Git for Windows (win32 only)
// ---------------------------------------------------------------------------

export function checkGitBash(deps: CheckDeps): SetupCheck | null {
  if (deps.platform !== 'win32') return null;
  const title = 'Git for Windows (Git Bash)';
  const p = pathFor('win32');
  const fromEnv = deps.env.CLAUDE_CODE_GIT_BASH_PATH;
  const candidates = [
    fromEnv,
    p.join(deps.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    p.join(deps.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    p.join(deps.env.LOCALAPPDATA || p.join(deps.homedir, 'AppData', 'Local'), 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter((c): c is string => Boolean(c));
  const hit = candidates.find((c) => deps.exists(c));
  if (hit) return { id: 'git_bash', title, status: 'ok', required: false, detail: `Git Bash found at ${hit}` };
  const git = findOnWindowsPath(deps, 'git')[0];
  if (git) {
    return { id: 'git_bash', title, status: 'ok', required: false, detail: `git found at ${git}` };
  }
  return {
    id: 'git_bash',
    title,
    status: 'warn',
    required: false,
    detail: 'Git for Windows was not found. Claude Code on Windows uses Git Bash for shell commands; the tagconn hook itself does not need it.',
    fix: { label: 'Get Git for Windows', action: 'open_url', target: GIT_FOR_WINDOWS_URL },
  };
}

// ---------------------------------------------------------------------------
// server port, dirs
// ---------------------------------------------------------------------------

export async function findNextFreePort(deps: CheckDeps, from: number, tries = 20): Promise<number | null> {
  for (let port = from + 1; port <= Math.min(from + tries, 65535); port++) {
    if ((await deps.bindPort(port)).ok) return port;
  }
  return null;
}

export async function checkServerPort(deps: CheckDeps, port: number): Promise<SetupCheck> {
  const title = `Server port ${port}`;
  const res = await deps.bindPort(port);
  if (res.ok) return { id: 'server_port', title, status: 'ok', required: true, detail: `127.0.0.1:${port} is free.` };
  const next = await findNextFreePort(deps, port);
  const why = res.code === 'EADDRINUSE' ? 'is already in use' : `cannot be used (${res.code})`;
  return {
    id: 'server_port',
    title,
    status: 'fail',
    required: true,
    detail:
      `Port ${port} ${why}. Close the program using it` +
      (next ? `, or use port ${next} instead.` : ', or pick another port.'),
    fix: { label: next ? `Use port ${next}` : 'Re-check', action: next ? 'use_next_free_port' : 'recheck', ...(next ? { target: String(next) } : {}) },
  };
}

function checkDir(deps: CheckDeps, id: 'config_dir' | 'data_dir', title: string, dir: string): SetupCheck {
  try {
    deps.writeTest(dir);
    return { id, title, status: 'ok', required: true, detail: `${dir} is writable.` };
  } catch (err) {
    return {
      id,
      title,
      status: 'fail',
      required: true,
      detail: `Cannot write to ${dir}: ${(err as Error).message}`,
      fix:
        id === 'data_dir'
          ? { label: 'Choose another folder', action: 'choose_data_dir' }
          : { label: 'Re-check', action: 'recheck' },
    };
  }
}

export const checkConfigDir = (deps: CheckDeps, dir: string): SetupCheck => checkDir(deps, 'config_dir', 'Config folder', dir);
export const checkDataDir = (deps: CheckDeps, dir: string): SetupCheck => checkDir(deps, 'data_dir', 'Data folder', dir);

// ---------------------------------------------------------------------------
// Claude settings + hooks
// ---------------------------------------------------------------------------

export function checkClaudeSettings(deps: CheckDeps, settingsPath: string): SetupCheck {
  const title = 'Claude Code settings';
  if (!deps.exists(settingsPath)) {
    return { id: 'claude_settings', title, status: 'ok', required: true, detail: `${settingsPath} does not exist yet; it will be created.` };
  }
  const openFile = { label: 'Open file', action: 'open_file' as const, target: settingsPath };
  try {
    deps.assertWritable(settingsPath);
  } catch (err) {
    return {
      id: 'claude_settings',
      title,
      status: 'fail',
      required: true,
      detail: `${settingsPath} is locked or read-only (${(err as Error).message}). Close whatever has it open, then retry.`,
      fix: { label: 'Retry', action: 'recheck' },
    };
  }
  let text = '';
  try {
    text = deps.readFile(settingsPath);
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('top-level value is not an object');
    return { id: 'claude_settings', title, status: 'ok', required: true, detail: `${settingsPath} is valid JSON.` };
  } catch (err) {
    // The same error the installer throws, so the wizard shows the parse position (line/column).
    const detail = new SettingsParseError(settingsPath, err as Error, text).message;
    return {
      id: 'claude_settings',
      title,
      status: 'fail',
      required: true,
      detail: `${detail}. tagconn will not touch this file until it is valid JSON.`,
      fix: openFile,
    };
  }
}

export function checkHooks(deps: CheckDeps, settingsPath: string): SetupCheck {
  const title = 'tagconn hooks';
  const installHooks = { label: 'Install hooks', action: 'install_hooks' as const };
  if (!deps.exists(settingsPath)) {
    return { id: 'hooks', title, status: 'warn', required: false, detail: 'Hooks are not installed yet.', fix: installHooks };
  }
  let sum: ReturnType<typeof summarizeHooks>;
  try {
    sum = summarizeHooks(JSON.parse(deps.readFile(settingsPath)));
  } catch {
    return { id: 'hooks', title, status: 'skip', required: false, detail: 'Skipped: settings.json could not be parsed.' };
  }
  if (sum.kind === null) {
    return { id: 'hooks', title, status: 'warn', required: false, detail: 'Hooks are not installed yet.', fix: installHooks };
  }
  const kindLabel = sum.kind === 'mixed' ? 'mixed sh and node' : sum.kind;
  if (sum.events !== HOOK_EVENTS.length || sum.kind === 'mixed') {
    return {
      id: 'hooks',
      title,
      status: 'warn',
      required: false,
      detail: `Hooks are only partly installed (${kindLabel} kind, ${sum.events} of ${HOOK_EVENTS.length} events).`,
      fix: installHooks,
    };
  }
  if (sum.kind === 'node' && sum.sample?.command) {
    const node = sum.sample.command;
    const runnable = deps.isExecutable ? deps.isExecutable(node) : deps.exists(node);
    if (!runnable) {
      return {
        id: 'hooks',
        title,
        status: 'fail',
        required: false,
        detail: `The hook runs ${node}, which does not exist or is not executable, so no events reach the office. Reinstall the hooks to register a working node.`,
        fix: installHooks,
      };
    }
  }
  return { id: 'hooks', title, status: 'ok', required: false, detail: `Hooks are installed for all ${HOOK_EVENTS.length} events (${kindLabel} kind).` };
}

// ---------------------------------------------------------------------------
// docker, runner platform
// ---------------------------------------------------------------------------

export function checkDocker(deps: CheckDeps, dockerMode: boolean): SetupCheck {
  const title = 'Docker';
  if (!dockerMode) {
    return { id: 'docker', title, status: 'skip', required: false, detail: 'Skipped: native mode does not use Docker.' };
  }
  const res = deps.exec('docker', ['info'], { timeoutMs: 15_000 });
  if (!res.error && res.status === 0) {
    return { id: 'docker', title, status: 'ok', required: true, detail: 'Docker is running.' };
  }
  const missing = (res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  return {
    id: 'docker',
    title,
    status: 'fail',
    required: true,
    detail: missing ? 'Docker is not installed.' : 'Docker is installed but not running. Start Docker Desktop (or the docker service).',
    fix: { label: 'Switch to native mode', action: 'switch_to_native' },
  };
}

/** Decision #28: what the runner can and cannot do on Windows. */
export function checkRunnerPlatform(deps: CheckDeps): SetupCheck | null {
  if (deps.platform !== 'win32') return null;
  return {
    id: 'runner_platform',
    title: 'Runner on Windows',
    status: 'warn',
    required: false,
    detail:
      'The runner works on Windows with stricter limits: Bash is always denied, the permission mode is capped at ' +
      'acceptEdits, and the Receptionist runs with a read-only tool set but no filesystem sandbox (no bwrap or systemd).',
  };
}

export interface RunChecksOptions {
  claudeDir: string;
  configDir: string;
  dataDir: string;
  port: number;
  dockerMode?: boolean;
  minClaudeVersion?: string;
}

/** All setup checks for this OS, in wizard order. Checks that do not apply to the OS are left out. */
export async function runSetupChecks(opts: RunChecksOptions, deps: CheckDeps = defaultCheckDeps()): Promise<SetupCheck[]> {
  const settingsPath = pathFor(deps.platform).join(opts.claudeDir, 'settings.json');
  const out: (SetupCheck | null)[] = [
    checkClaudeCli(deps, { minVersion: opts.minClaudeVersion }),
    checkClaudeLogin(deps),
    checkGitBash(deps),
    await checkServerPort(deps, opts.port),
    checkConfigDir(deps, opts.configDir),
    checkDataDir(deps, opts.dataDir),
    checkClaudeSettings(deps, settingsPath),
    checkHooks(deps, settingsPath),
    checkDocker(deps, opts.dockerMode ?? false),
    checkRunnerPlatform(deps),
  ];
  return out.filter((c): c is SetupCheck => c !== null);
}
