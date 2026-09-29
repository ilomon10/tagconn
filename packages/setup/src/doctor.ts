import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCheckDeps, findClaude } from './checks.ts';
import {
  HOOK_EVENTS,
  hookKindOf,
  isOurEntry,
  loadSettings,
  summarizeHooks,
  type HookEntry,
  type HookKind,
  type SettingsJson,
} from './claudeSettings.ts';
import { defaultRepoRoot } from './context.ts';
import { isBroadAllowDir } from './runnerConfig.ts';
import { defaultExec, verifySecretFile, type ExecFn, type ExecResult } from './secrets.ts';

/** Where doctor's lines go. The CLI prints them (with colours) and counts hard failures. */
export interface DoctorReporter {
  ok: (label: string) => void;
  /** A hard failure by default (`hard = false` reports without failing the run). */
  fail: (label: string, hint: string, hard?: boolean) => void;
  warn: (label: string, hint: string) => void;
  /** A check that does not apply on this OS. Never a failure. */
  na: (label: string, note: string) => void;
  /** A plain line (headings, blank lines). */
  line: (text: string) => void;
}

export interface DoctorEnv extends DoctorReporter {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exec: ExecFn;
  /** Where docker-compose.yml and .env live (the repo checkout). */
  repoRoot: string;
}

export function createDoctorEnv(reporter: DoctorReporter, partial: Partial<Omit<DoctorEnv, keyof DoctorReporter>> = {}): DoctorEnv {
  return { ...reporter, platform: process.platform, env: process.env, exec: defaultExec, repoRoot: defaultRepoRoot, ...partial };
}

interface SecretProblem {
  what: string;
  hint: string;
}

/** POSIX: the file mode must be 600. win32: icacls must show only the current user (no false mode failures). */
function secretProblem(d: DoctorEnv, path: string): SecretProblem | null {
  const check = verifySecretFile(path, { platform: d.platform, env: d.env, exec: d.exec });
  if (check.ok) return null;
  if (check.kind === 'mode') return { what: `has mode ${check.mode}, expected 600`, hint: `Run: chmod 600 ${path}` };
  return { what: `is accessible by other users (${check.detail})`, hint: check.hint };
}

function secretLabel(d: DoctorEnv): string {
  return d.platform === 'win32' ? 'user-only ACL' : 'mode 600';
}

/** `claude <args>`: by name on POSIX (as before), through the resolved path (and cmd.exe for .cmd shims) on win32. */
function claudeInvoker(d: DoctorEnv): (args: string[]) => ExecResult {
  return (args) => {
    if (d.platform !== 'win32') return d.exec('claude', args, { timeoutMs: 5000 });
    const deps = { ...defaultCheckDeps(), platform: d.platform, env: d.env, exec: d.exec };
    const path = findClaude(deps);
    if (!path) return { status: null, stdout: '', stderr: '', error: new Error('claude not found') };
    return /\.(cmd|bat)$/i.test(path)
      ? d.exec('cmd.exe', ['/d', '/c', path, ...args], { timeoutMs: 5000 })
      : d.exec(path, args, { timeoutMs: 5000 });
  };
}

export function checkCurl(d: DoctorEnv): void {
  const res = d.exec('curl', ['--version']);
  if (res.status === 0) {
    d.ok('curl is installed');
  } else {
    d.fail('curl is not installed', 'Install curl - the hook script depends on it to reach the server.');
  }
}

export function checkCurlConf(d: DoctorEnv, configDir: string): void {
  const path = join(configDir, 'curl.conf');
  if (!existsSync(path)) {
    d.fail(`curl.conf missing (${path})`, 'Run `pnpm office:install`.');
    return;
  }
  try {
    const bad = secretProblem(d, path);
    if (bad) {
      d.fail(`curl.conf ${bad.what} (${path})`, bad.hint);
      return;
    }
    const content = readFileSync(path, 'utf8');
    if (/header\s*=\s*"x-office-token:/.test(content) && /url\s*=\s*"/.test(content)) {
      d.ok(`curl.conf present, ${secretLabel(d)}, and readable (${path})`);
    } else {
      d.fail(`curl.conf is missing the header or url directive (${path})`, 'Re-run `pnpm office:install`.');
    }
  } catch (err) {
    d.fail(`curl.conf is not readable (${path})`, String((err as Error).message));
  }
}

/** attribution.conf holds the hook token too (SC4 INFO): same mode-600 check as curl.conf, but optional (opt-in feature). */
export function checkAttributionConf(d: DoctorEnv, configDir: string): void {
  const path = join(configDir, 'attribution.conf');
  if (!existsSync(path)) {
    d.warn(`attribution.conf not found (${path})`, 'Optional: run `pnpm office:install` (it is installed by default unless removed).');
    return;
  }
  try {
    const bad = secretProblem(d, path);
    if (bad) {
      d.fail(`attribution.conf ${bad.what} (${path})`, bad.hint);
      return;
    }
    d.ok(`attribution.conf present, ${secretLabel(d)} (${path})`);
  } catch (err) {
    d.fail(`attribution.conf is not readable (${path})`, String((err as Error).message));
  }
}

/** The repo .env holds OFFICE_HOOK_TOKEN and OFFICE_RUNNER__TOKEN (SC4 INFO): warn if it's not mode 600. */
export function checkEnvFileMode(d: DoctorEnv): void {
  const path = join(d.repoRoot, '.env');
  if (!existsSync(path)) {
    d.warn(`.env not found (${path})`, 'Optional: run `pnpm office:install` to create it.');
    return;
  }
  try {
    const bad = secretProblem(d, path);
    if (bad) {
      d.warn(`.env ${bad.what} (${path})`, `It holds secrets - ${bad.hint.replace(/^Run: /, 'run: ')}`);
      return;
    }
    d.ok(`.env present, ${secretLabel(d)} (${path})`);
  } catch (err) {
    d.warn(`.env is not readable (${path})`, String((err as Error).message));
  }
}

export function checkHookScript(d: DoctorEnv, configDir: string, kind: HookKind = 'sh'): void {
  if (kind === 'node') {
    const script = join(configDir, 'office-hook.mjs');
    if (existsSync(script)) {
      d.ok(`node hook script installed (${script})`);
    } else {
      d.fail(`node hook script missing (${script})`, 'Run `pnpm office:install --hook node`.');
    }
    const cfg = join(configDir, 'hook.json');
    if (!existsSync(cfg)) {
      d.fail(`hook.json missing (${cfg})`, 'Run `pnpm office:install --hook node`.');
      return;
    }
    const bad = secretProblem(d, cfg);
    if (bad) {
      d.fail(`hook.json ${bad.what} (${cfg})`, bad.hint);
    } else {
      d.ok(`hook.json present, ${secretLabel(d)} (${cfg})`);
    }
    return;
  }
  const path = join(configDir, 'office-hook.sh');
  if (!existsSync(path)) {
    d.fail(`hook script missing (${path})`, 'Run `pnpm office:install`.');
    return;
  }
  if (d.platform === 'win32') {
    // No exec bit on Windows; Claude Code runs the command through Git Bash.
    d.ok(`hook script installed (${path}; the executable bit does not apply on Windows)`);
    return;
  }
  const mode = statSync(path).mode;
  const executable = (mode & 0o111) !== 0;
  if (executable) {
    d.ok(`hook script installed and executable (${path})`);
  } else {
    d.fail(`hook script is not executable (${path})`, `Run: chmod 755 ${path}`);
  }
}

/** Pulls the script path out of a hook command's trailing quoted argument. */
export function extractHookScriptPath(command: string): string | null {
  const match = command.trim().match(/(?:"([^"]*)"|'([^']*)')\s*$/);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/** Which hook kind settings.json registers (null: none, or the file is missing/unparsable). */
export function detectHookKind(claudeDir: string): HookKind | 'mixed' | null {
  try {
    return summarizeHooks(loadSettings(join(claudeDir, 'settings.json'))).kind;
  } catch {
    return null;
  }
}

export function checkSettingsHooks(d: DoctorEnv, claudeDir: string): void {
  const path = join(claudeDir, 'settings.json');
  if (!existsSync(path)) {
    d.fail(`settings.json missing (${path})`, 'Run `pnpm office:install`.');
    return;
  }
  let settings: SettingsJson;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    d.fail(`settings.json is not valid JSON (${path})`, String((err as Error).message));
    return;
  }
  const hooks = settings.hooks || {};
  const missing: string[] = [];
  let sample: HookEntry | undefined;
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event] || [];
    let present = false;
    for (const g of groups) {
      for (const h of g.hooks || []) {
        if (isOurEntry(h)) {
          present = true;
          sample ??= h;
        }
      }
    }
    if (!present) missing.push(event);
  }
  if (missing.length === 0) {
    d.ok(`settings.json has tagconn hooks for all ${HOOK_EVENTS.length} events`);
  } else {
    d.fail(`settings.json is missing tagconn hooks for: ${missing.join(', ')}`, 'Run `pnpm office:install`.');
  }

  if (!sample) return;
  if (hookKindOf(sample) === 'node') {
    const scriptPath = sample.args?.find((a) => typeof a === 'string' && /office-hook\.mjs$/.test(a));
    if (!scriptPath || !existsSync(scriptPath)) {
      d.fail(`hook command points at a script that does not exist (${scriptPath ?? 'unknown'})`, 'Re-run `pnpm office:install --hook node`.');
    } else if (!existsSync(sample.command)) {
      d.fail(`hook command points at a node executable that does not exist (${sample.command})`, 'Re-run `pnpm office:install --hook node`.');
    } else {
      d.ok(`hook command points at an existing script (${scriptPath}) and node (${sample.command})`);
    }
    return;
  }
  const sampleCommand = sample.command;
  const scriptPath = extractHookScriptPath(sampleCommand);
  if (!scriptPath) {
    d.fail(`could not parse a script path out of the hook command (${sampleCommand})`, 'Re-run `pnpm office:install`.');
  } else if (!existsSync(scriptPath)) {
    d.fail(`hook command points at a script that does not exist (${scriptPath})`, 'Re-run `pnpm office:install`.');
  } else if (d.platform === 'win32') {
    d.ok(`hook command points at an existing script (${scriptPath})`);
  } else if ((statSync(scriptPath).mode & 0o111) === 0) {
    d.fail(`hook command's script is not executable (${scriptPath})`, `Run: chmod 755 ${scriptPath}`);
  } else {
    d.ok(`hook command points at an existing, executable script (${scriptPath})`);
  }
}

/**
 * H2 (SC5): quests and the Receptionist spawn `claude` with `--setting-sources=user`, so the user's
 * own `~/.claude/settings.json` (or `--claude-dir`) `permissions.allow` rules and
 * `additionalDirectories` ARE inherited by every quest, on top of whatever the runner's own
 * `questToolPolicy`/`--tools` restriction allows (defense in depth, not a substitute for it — see
 * docs/design/runner-and-helpdesk.md §0/§2.1). `permissions.defaultMode` is reported too, for the same
 * settings.json, even though quests/the Receptionist always pass an explicit `--permission-mode` that
 * overrides it for THEM (apps/runner/src/argv.ts) — it still governs any other, non-tagconn `claude`
 * invocation that reads this same file. Always a warning (never a hard failure): these can be
 * legitimate, deliberate user choices; this check exists so the user can make that choice knowingly.
 */
/**
 * SC5 re-review (recommended): a bare (unscoped) or effectively-unbounded Edit/Write/Read allow rule.
 * Mirrors `apps/runner/src/userSettingsAudit.ts`'s `isBroadFileToolRule` (duplicated, not imported:
 * scripts/ stays node:-builtins-only, erasable TS, no cross-package deps — see CLAUDE.md). Quests
 * default to a project-scoped `Edit(./**)`/`Write(./**)` (SC5 M1), so a bare user-level rule here is a
 * real widening beyond that default, not merely redundant with it.
 */
function isBroadFileToolRule(rule: string): boolean {
  return /^(Edit|Write|Read)$/.test(rule) || /^(Edit|Write|Read)\(\/?\*\*?\)$/.test(rule);
}

export function checkUserPermissions(d: DoctorEnv, claudeDir: string): void {
  const path = join(claudeDir, 'settings.json');
  if (!existsSync(path)) return; // already reported (missing/invalid) by checkSettingsHooks
  let settings: { permissions?: { allow?: unknown; additionalDirectories?: unknown; defaultMode?: unknown } };
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return; // already reported as invalid JSON by checkSettingsHooks
  }
  const permissions = settings.permissions ?? {};

  const allow = Array.isArray(permissions.allow) ? permissions.allow.filter((r): r is string => typeof r === 'string') : [];
  const risky = allow.filter((r) => r === 'Bash' || r.startsWith('Bash(') || r === 'WebFetch' || r.startsWith('WebFetch(') || r.startsWith('mcp__'));
  if (risky.length > 0) {
    d.warn(
      `settings.json permissions.allow has ${risky.length} Bash/WebFetch/mcp__ rule(s): ${risky.join(', ')}`,
      'Quests run with --setting-sources=user, so these allow rules ARE inherited by every quest, ' +
        'in addition to whatever the runner itself allows (runner.json questToolPolicy/--tools is ' +
        'defense in depth on top of this, not a substitute for it). Narrow or remove these rules if ' +
        'you do not want quests to have them too.',
    );
  }

  const broadFileRules = allow.filter(isBroadFileToolRule);
  if (broadFileRules.length > 0) {
    d.warn(
      `settings.json permissions.allow has ${broadFileRules.length} bare/broad Edit, Write or Read rule(s): ${broadFileRules.join(', ')}`,
      'Quests run with --setting-sources=user too, so a bare or `**`-style Edit/Write/Read rule here is ' +
        "inherited by every quest, widening past the runner's own default project-scoped `Edit(./**)`/" +
        '`Write(./**)` rules (runner.json questToolPolicy is a ceiling on top of this, not a substitute ' +
        'for it). Scope these rules (e.g. `Edit(./**)`) if you do not want quests to edit/read anywhere on disk.',
    );
  }

  const additionalDirectories = Array.isArray(permissions.additionalDirectories)
    ? permissions.additionalDirectories.filter((d): d is string => typeof d === 'string')
    : [];
  if (additionalDirectories.length > 0) {
    d.warn(
      `settings.json permissions.additionalDirectories is set: ${additionalDirectories.join(', ')}`,
      'Quests inherit this too (--setting-sources=user): they can reach these directories in addition ' +
        'to the project dir, regardless of runner.json allowedProjectDirs.',
    );
  }

  if (typeof permissions.defaultMode === 'string' && permissions.defaultMode !== 'plan') {
    d.warn(
      `settings.json permissions.defaultMode is "${permissions.defaultMode}"`,
      'Quests and the Receptionist always pass an explicit --permission-mode, which overrides this ' +
        'for them — but any OTHER claude invocation that reads this same settings.json inherits it. ' +
        '"plan" is the safest default.',
    );
  }
}

export interface HealthProbe {
  reachable: boolean;
  status?: number;
  body?: { instanceId?: string; version?: string; [k: string]: unknown };
}

/** GETs <url>/api/health with a short timeout; never throws. */
export async function probeHealth(url: string, timeoutMs = 1500): Promise<HealthProbe> {
  const healthUrl = `${url.replace(/\/$/, '')}/api/health`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timeout);
    let body: HealthProbe['body'];
    try {
      body = (await res.json()) as HealthProbe['body'];
    } catch {
      body = undefined;
    }
    return { reachable: true, status: res.status, body };
  } catch {
    return { reachable: false };
  }
}

export async function checkServerHealth(d: DoctorEnv, url: string): Promise<HealthProbe> {
  const healthUrl = `${url.replace(/\/$/, '')}/api/health`;
  const probe = await probeHealth(url);
  if (!probe.reachable) {
    d.warn(`server not reachable at ${healthUrl}`, 'Start it with `pnpm office:up` (docker) or `pnpm dev`. Hooks queue nothing while it is down.');
  } else if (probe.status !== 200) {
    d.fail(`server responded with HTTP ${probe.status} at ${healthUrl}`, 'Check server logs (`pnpm office:up` or `pnpm dev`).');
  } else {
    d.ok(`server reachable at ${healthUrl}`);
  }
  return probe;
}

export function checkDockerCompose(d: DoctorEnv): void {
  const composeFile = join(d.repoRoot, 'docker-compose.yml');
  if (!existsSync(composeFile)) {
    d.warn('docker-compose.yml not found', 'Optional check skipped.');
    return;
  }
  const res = d.exec('docker', ['compose', 'ps', '--status', 'running', '--format', 'json'], { cwd: d.repoRoot });
  if (res.error || res.status !== 0) {
    d.warn('docker compose not running (or docker not installed)', 'Optional: run `pnpm office:up` to start the containers.');
    return;
  }
  const output = res.stdout.trim();
  if (output.length > 0) {
    d.ok('docker compose services are running');
  } else {
    d.warn('docker compose services are not running', 'Optional: run `pnpm office:up` to start the containers.');
  }
}

// ---------------------------------------------------------------------------
// M8: runner config, CLI capabilities, pairing, the :4318 squatter check
// ---------------------------------------------------------------------------

/** Reports runner.json's presence/mode and warns on broad allowedProjectDirs (mirrors scripts/install.ts). */
export function checkRunnerConfig(d: DoctorEnv, configDir: string): void {
  const path = join(configDir, 'runner.json');
  if (!existsSync(path)) {
    d.warn(
      `runner.json not found (${path})`,
      'Optional: run `pnpm office:install --allow-dir <path>` to let quests/the Receptionist run in a project.',
    );
    return;
  }
  let config: { token?: unknown; allowedProjectDirs?: unknown };
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    d.fail(`runner.json is not valid JSON (${path})`, String((err as Error).message));
    return;
  }
  try {
    const bad = secretProblem(d, path);
    if (bad) {
      d.fail(`runner.json ${bad.what} (${path})`, bad.hint);
    } else {
      d.ok(`runner.json present, ${secretLabel(d)} (${path})`);
    }
  } catch (err) {
    d.fail(`runner.json is not readable (${path})`, String((err as Error).message));
  }
  const dirs = Array.isArray(config.allowedProjectDirs)
    ? config.allowedProjectDirs.filter((d): d is string => typeof d === 'string')
    : [];
  if (dirs.length === 0) {
    d.warn(
      'runner.json has no allowedProjectDirs',
      'Quests and the Receptionist project scope have nowhere to run. Add one with `--allow-dir <path>`.',
    );
  } else {
    d.ok(`runner.json allows ${dirs.length} project dir(s): ${dirs.join(', ')}`);
    for (const dir of dirs.filter(isBroadAllowDir)) {
      d.warn(
        `${dir} looks like a broad parent directory`,
        'It is $HOME/root, or has more than 3 git repos under it - quests/the Receptionist could run in any repo ' +
          'below it. Prefer listing individual project directories.',
      );
    }
  }
}

/** Smoke-checks the flags the runner requires on every spawn (see docs/design/runner-and-helpdesk.md §2.1). */
export function checkCliCapabilities(d: DoctorEnv): void {
  const claude = claudeInvoker(d);
  const res = claude(['--help']);
  if (res.error) {
    d.warn('claude CLI not found (or `claude --help` failed)', 'Install/log in to Claude Code; the runner and Receptionist both spawn `claude`.');
    return;
  }
  const help = `${res.stdout}${res.stderr}`;
  const requiredFlags = ['--setting-sources', '--strict-mcp-config', '--tools', '--restricted'];
  const missing = requiredFlags.filter((f) => !help.includes(f));
  if (missing.length === 0) {
    d.ok('claude --help lists --setting-sources, --strict-mcp-config, --tools and --restricted');
  } else {
    d.warn(
      `claude --help is missing: ${missing.join(', ')}`,
      'The runner requires all of these on every spawn; an older/newer claude CLI may need a runner update ' +
        '(see docs/design/runner-and-helpdesk.md §2.1).',
    );
  }
  const version = claude(['--version']);
  if (!version.error && version.stdout.trim()) {
    d.ok(`claude --version: ${version.stdout.trim()}`);
  }
}

/** Quests that can execute commands need a cgroup kill (systemd scope); see V13 in the design doc. */
export function checkSystemdScope(d: DoctorEnv): void {
  if (d.platform === 'win32') {
    d.na(
      'systemd-run --user --scope',
      'Not applicable on Windows: quests are contained with `taskkill /T`, and quests that can execute commands are always refused (decision #28).',
    );
    return;
  }
  const res = d.exec('systemd-run', ['--user', '--scope', '--quiet', '--', 'true']);
  if (!res.error && res.status === 0) {
    d.ok('systemd-run --user --scope works (quest process containment available)');
  } else {
    d.warn(
      'systemd-run --user --scope is not available',
      'Quests that can execute commands (Bash rules, auto/bypassPermissions modes) are refused without it (isolation_unavailable).',
    );
  }
}

/** bubblewrap sandboxes the Receptionist; see §4.3/4.4. Its absence is a documented, non-fatal degradation. */
export function checkBwrap(d: DoctorEnv): void {
  if (d.platform === 'win32') {
    d.na('bwrap', 'Not applicable on Windows: the Receptionist runs with a read-only tool set and no filesystem sandbox (decision #28).');
    return;
  }
  const res = d.exec('bwrap', ['--version']);
  if (!res.error && res.status === 0) {
    d.ok(`bwrap available (${(res.stdout || '').trim() || 'version unknown'}) - Receptionist sandboxing possible`);
  } else {
    d.warn(
      'bwrap not available',
      'The Receptionist falls back to --restricted alone (no filesystem sandbox); see docs/design/runner-and-helpdesk.md §4.4.',
    );
  }
}

export async function checkPairingStatus(d: DoctorEnv, url: string): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${url.replace(/\/$/, '')}/api/auth/status`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      d.warn(`/api/auth/status returned HTTP ${res.status}`, 'Check server logs.');
      return;
    }
    const body = (await res.json()) as { mode?: string; admin?: boolean };
    // doctor never carries an admin token itself, so `admin: false` here is expected and not a
    // problem to flag - it says nothing about whether a browser elsewhere is paired.
    const adminNote = body.admin === true ? 'admin=true' : 'not checked without a session (normal for this CLI)';
    d.ok(`pairing: auth.mode=${body.mode ?? 'unknown'} (${adminNote})`);
  } catch {
    d.warn('could not reach /api/auth/status', 'Start the server (`pnpm office:up` or `pnpm dev`) to check pairing status.');
  }
}

/**
 * Squatter check (see docs/design/runner-and-helpdesk.md §5.2, T9): compares the direct server's
 * instanceId/version against the same fetched through the web origin (nginx/Vite dev). A mismatch
 * means something other than tagconn's server is answering on the web port's proxied API. NOTE this
 * is a residual-risk check, not a guarantee: a squatter that itself proxies /api/health would pass it.
 */
export async function checkSquatter(d: DoctorEnv, url: string, webUrl: string, direct: HealthProbe): Promise<void> {
  if (!direct.reachable || direct.status !== 200 || !direct.body?.instanceId) {
    d.warn('squatter check skipped', `the server at ${url} was not reachable; re-run once it is up.`);
    return;
  }
  const web = await probeHealth(webUrl);
  if (!web.reachable) {
    d.warn(
      `web origin not reachable at ${webUrl}/api/health`,
      'Start the web app/proxy (`pnpm office:up` or `pnpm dev`) to run the :4318 squatter check.',
    );
    return;
  }
  if (web.status !== 200 || !web.body?.instanceId) {
    d.fail(`web origin at ${webUrl} did not return a usable /api/health body`, 'Check the nginx/Vite proxy config.');
    return;
  }
  if (web.body.instanceId === direct.body.instanceId && web.body.version === direct.body.version) {
    d.ok(`web origin (${webUrl}) matches the server's instanceId and version - no :4318 squatter detected`);
  } else {
    d.fail(
      `web origin (${webUrl}) reports a DIFFERENT instanceId/version than the server at ${url}`,
      'Something else may be listening on the web port. Stop it, or check `docker compose ps` / `lsof -i :4318`. ' +
        'A squatter that itself proxies /api/health would still pass this check (residual risk, §5.2).',
    );
  }
}


export interface DoctorOptions {
  claudeDir: string;
  configDir: string;
  url: string;
  webUrl: string;
}

/** Runs every doctor check in the CLI's order. Results go through `d`'s reporter. */
export async function runDoctor(opts: DoctorOptions, d: DoctorEnv): Promise<void> {
  d.line('tagconn doctor\n');
  d.line(`claude dir: ${opts.claudeDir}`);
  d.line(`config dir: ${opts.configDir}\n`);
  const kind = detectHookKind(opts.claudeDir);
  // The node hook needs neither curl nor curl.conf; everything else about the sh hook is unchanged.
  if (kind !== 'node') {
    checkCurl(d);
    checkCurlConf(d, opts.configDir);
  }
  checkHookScript(d, opts.configDir, kind === 'node' ? 'node' : 'sh');
  checkSettingsHooks(d, opts.claudeDir);
  checkUserPermissions(d, opts.claudeDir);
  const direct = await checkServerHealth(d, opts.url);
  checkDockerCompose(d);
  checkEnvFileMode(d);

  d.line('\n[runner]');
  if (kind !== 'node') checkAttributionConf(d, opts.configDir);
  checkRunnerConfig(d, opts.configDir);
  checkCliCapabilities(d);
  checkSystemdScope(d);
  checkBwrap(d);

  d.line('\n[pairing]');
  await checkPairingStatus(d, opts.url);
  await checkSquatter(d, opts.url, opts.webUrl, direct);
}
