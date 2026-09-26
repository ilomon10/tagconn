#!/usr/bin/env node
// tagconn doctor: sanity-checks the local install (hook, curl.conf, Claude Code
// settings, server reachability, docker compose, the M8 runner + pairing).
// Prints one line per check and exits 1 if any hard check fails.
//
// Node 24 runs this directly (type stripping) — erasable TS syntax only,
// node: builtins only, no npm dependencies.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isBroadAllowDir, validateUrl } from './install.ts';

const HOOK_MARKER = 'tagconn/office-hook.sh';
const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Notification',
  'PreCompact',
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

export interface Args {
  claudeDir: string;
  configDir: string;
  url: string;
  /** The browser-facing origin (nginx/Vite dev), used for the :4318 squatter check. */
  webUrl: string;
  help: boolean;
}

const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude');
const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'tagconn');

export interface ResolveConfigDirInputs {
  configDirFlag: string | undefined;
  configDirEnv: string | undefined;
  claudeDirExplicit: boolean;
  claudeDir: string;
}

/**
 * Resolves the config dir. Mirrors scripts/install.ts's resolveConfigDir:
 * --config-dir flag > TAGCONN_CONFIG_DIR env > derived from a non-default
 * claude dir > ~/.config/tagconn.
 */
export function resolveConfigDir(inputs: ResolveConfigDirInputs): string {
  if (inputs.configDirFlag) {
    return inputs.configDirFlag;
  }
  if (inputs.configDirEnv) {
    return resolve(inputs.configDirEnv);
  }
  if (inputs.claudeDirExplicit && resolve(inputs.claudeDir) !== DEFAULT_CLAUDE_DIR) {
    return join(dirname(inputs.claudeDir), '.config', 'tagconn');
  }
  return DEFAULT_CONFIG_DIR;
}

export function parseArgs(argv: string[]): Args {
  const envClaudeDir = process.env.CLAUDE_CONFIG_DIR;
  let claudeDirExplicit = Boolean(envClaudeDir);
  let configDirFlag: string | undefined;

  const args: Args = {
    claudeDir: envClaudeDir ? resolve(envClaudeDir) : DEFAULT_CLAUDE_DIR,
    configDir: DEFAULT_CONFIG_DIR, // resolved below, once all flags are parsed
    url: validateUrl(process.env.OFFICE_URL || 'http://127.0.0.1:4317'),
    webUrl: validateUrl(process.env.OFFICE_WEB_URL || 'http://127.0.0.1:4318'),
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--claude-dir') {
      args.claudeDir = resolve(argv[++i] ?? '');
      claudeDirExplicit = true;
    } else if (a === '--config-dir') {
      configDirFlag = resolve(argv[++i] ?? '');
    } else if (a === '--url') args.url = validateUrl(argv[++i] ?? args.url);
    else if (a === '--web-url') args.webUrl = validateUrl(argv[++i] ?? args.webUrl);
    else if (a === '--help' || a === '-h') args.help = true;
  }

  // Same resolution as scripts/install.ts: --config-dir flag > TAGCONN_CONFIG_DIR
  // env > derived from a non-default claude dir > ~/.config/tagconn.
  args.configDir = resolveConfigDir({
    configDirFlag,
    configDirEnv: process.env.TAGCONN_CONFIG_DIR,
    claudeDirExplicit,
    claudeDir: args.claudeDir,
  });
  return args;
}

let hardFailures = 0;

function ok(label: string): void {
  console.log(`\x1b[32m✔\x1b[0m ${label}`);
}

function fail(label: string, hint: string, hard = true): void {
  console.log(`\x1b[31m✖\x1b[0m ${label}`);
  console.log(`    ${hint}`);
  if (hard) hardFailures++;
}

function warn(label: string, hint: string): void {
  console.log(`\x1b[33m○\x1b[0m ${label}`);
  console.log(`    ${hint}`);
}

function checkCurl(): void {
  const res = spawnSync('curl', ['--version'], { stdio: 'ignore' });
  if (res.status === 0) {
    ok('curl is installed');
  } else {
    fail('curl is not installed', 'Install curl - the hook script depends on it to reach the server.');
  }
}

function checkCurlConf(configDir: string): void {
  const path = join(configDir, 'curl.conf');
  if (!existsSync(path)) {
    fail(`curl.conf missing (${path})`, 'Run `pnpm office:install`.');
    return;
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      fail(`curl.conf has mode ${mode.toString(8)}, expected 600 (${path})`, `Run: chmod 600 ${path}`);
      return;
    }
    const content = readFileSync(path, 'utf8');
    if (/header\s*=\s*"x-office-token:/.test(content) && /url\s*=\s*"/.test(content)) {
      ok(`curl.conf present, mode 600, and readable (${path})`);
    } else {
      fail(`curl.conf is missing the header or url directive (${path})`, 'Re-run `pnpm office:install`.');
    }
  } catch (err) {
    fail(`curl.conf is not readable (${path})`, String((err as Error).message));
  }
}

/** attribution.conf holds the hook token too (SC4 INFO): same mode-600 check as curl.conf, but optional (opt-in feature). */
function checkAttributionConf(configDir: string): void {
  const path = join(configDir, 'attribution.conf');
  if (!existsSync(path)) {
    warn(`attribution.conf not found (${path})`, 'Optional: run `pnpm office:install` (it is installed by default unless removed).');
    return;
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      fail(`attribution.conf has mode ${mode.toString(8)}, expected 600 (${path})`, `Run: chmod 600 ${path}`);
      return;
    }
    ok(`attribution.conf present, mode 600 (${path})`);
  } catch (err) {
    fail(`attribution.conf is not readable (${path})`, String((err as Error).message));
  }
}

/** The repo .env holds OFFICE_HOOK_TOKEN and OFFICE_RUNNER__TOKEN (SC4 INFO): warn if it's not mode 600. */
function checkEnvFileMode(): void {
  const path = join(repoRoot, '.env');
  if (!existsSync(path)) {
    warn(`.env not found (${path})`, 'Optional: run `pnpm office:install` to create it.');
    return;
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      warn(`.env has mode ${mode.toString(8)}, expected 600 (${path})`, `It holds secrets - run: chmod 600 ${path}`);
      return;
    }
    ok(`.env present, mode 600 (${path})`);
  } catch (err) {
    warn(`.env is not readable (${path})`, String((err as Error).message));
  }
}

function checkHookScript(configDir: string): void {
  const path = join(configDir, 'office-hook.sh');
  if (!existsSync(path)) {
    fail(`hook script missing (${path})`, 'Run `pnpm office:install`.');
    return;
  }
  const mode = statSync(path).mode;
  const executable = (mode & 0o111) !== 0;
  if (executable) {
    ok(`hook script installed and executable (${path})`);
  } else {
    fail(`hook script is not executable (${path})`, `Run: chmod 755 ${path}`);
  }
}

/** Mirrors scripts/install.ts's isOurCommand: matches both hook command forms. */
export function isOurCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  if (command.includes(HOOK_MARKER)) return true;
  return command.includes('TAGCONN_CURL_CONF=') && command.includes('office-hook.sh');
}

/** Pulls the script path out of a hook command's trailing quoted argument. */
export function extractHookScriptPath(command: string): string | null {
  const match = command.trim().match(/(?:"([^"]*)"|'([^']*)')\s*$/);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

function checkSettingsHooks(claudeDir: string): void {
  const path = join(claudeDir, 'settings.json');
  if (!existsSync(path)) {
    fail(`settings.json missing (${path})`, 'Run `pnpm office:install`.');
    return;
  }
  let settings: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`settings.json is not valid JSON (${path})`, String((err as Error).message));
    return;
  }
  const hooks = settings.hooks || {};
  const missing: string[] = [];
  let sampleCommand: string | undefined;
  for (const event of HOOK_EVENTS) {
    const groups = hooks[event] || [];
    let present = false;
    for (const g of groups) {
      for (const h of g.hooks || []) {
        if (isOurCommand(h.command)) {
          present = true;
          if (!sampleCommand && typeof h.command === 'string') sampleCommand = h.command;
        }
      }
    }
    if (!present) missing.push(event);
  }
  if (missing.length === 0) {
    ok(`settings.json has tagconn hooks for all ${HOOK_EVENTS.length} events`);
  } else {
    fail(`settings.json is missing tagconn hooks for: ${missing.join(', ')}`, 'Run `pnpm office:install`.');
  }

  if (sampleCommand) {
    const scriptPath = extractHookScriptPath(sampleCommand);
    if (!scriptPath) {
      fail(`could not parse a script path out of the hook command (${sampleCommand})`, 'Re-run `pnpm office:install`.');
    } else if (!existsSync(scriptPath)) {
      fail(`hook command points at a script that does not exist (${scriptPath})`, 'Re-run `pnpm office:install`.');
    } else if ((statSync(scriptPath).mode & 0o111) === 0) {
      fail(`hook command's script is not executable (${scriptPath})`, `Run: chmod 755 ${scriptPath}`);
    } else {
      ok(`hook command points at an existing, executable script (${scriptPath})`);
    }
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
function checkUserPermissions(claudeDir: string): void {
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
    warn(
      `settings.json permissions.allow has ${risky.length} Bash/WebFetch/mcp__ rule(s): ${risky.join(', ')}`,
      'Quests run with --setting-sources=user, so these allow rules ARE inherited by every quest, ' +
        'in addition to whatever the runner itself allows (runner.json questToolPolicy/--tools is ' +
        'defense in depth on top of this, not a substitute for it). Narrow or remove these rules if ' +
        'you do not want quests to have them too.',
    );
  }

  const additionalDirectories = Array.isArray(permissions.additionalDirectories)
    ? permissions.additionalDirectories.filter((d): d is string => typeof d === 'string')
    : [];
  if (additionalDirectories.length > 0) {
    warn(
      `settings.json permissions.additionalDirectories is set: ${additionalDirectories.join(', ')}`,
      'Quests inherit this too (--setting-sources=user): they can reach these directories in addition ' +
        'to the project dir, regardless of runner.json allowedProjectDirs.',
    );
  }

  if (typeof permissions.defaultMode === 'string' && permissions.defaultMode !== 'plan') {
    warn(
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
async function probeHealth(url: string, timeoutMs = 1500): Promise<HealthProbe> {
  const healthUrl = `${url.replace(/\/$/, '')}/api/health`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timeout);
    let body: HealthProbe['body'];
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { reachable: true, status: res.status, body };
  } catch {
    return { reachable: false };
  }
}

async function checkServerHealth(url: string): Promise<HealthProbe> {
  const healthUrl = `${url.replace(/\/$/, '')}/api/health`;
  const probe = await probeHealth(url);
  if (!probe.reachable) {
    warn(`server not reachable at ${healthUrl}`, 'Start it with `pnpm office:up` (docker) or `pnpm dev`. Hooks queue nothing while it is down.');
  } else if (probe.status !== 200) {
    fail(`server responded with HTTP ${probe.status} at ${healthUrl}`, 'Check server logs (`pnpm office:up` or `pnpm dev`).');
  } else {
    ok(`server reachable at ${healthUrl}`);
  }
  return probe;
}

function checkDockerCompose(): void {
  const composeFile = join(repoRoot, 'docker-compose.yml');
  if (!existsSync(composeFile)) {
    warn('docker-compose.yml not found', 'Optional check skipped.');
    return;
  }
  const res = spawnSync('docker', ['compose', 'ps', '--status', 'running', '--format', 'json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (res.error || res.status !== 0) {
    warn('docker compose not running (or docker not installed)', 'Optional: run `pnpm office:up` to start the containers.');
    return;
  }
  const output = res.stdout.trim();
  if (output.length > 0) {
    ok('docker compose services are running');
  } else {
    warn('docker compose services are not running', 'Optional: run `pnpm office:up` to start the containers.');
  }
}

// ---------------------------------------------------------------------------
// M8: runner config, CLI capabilities, pairing, the :4318 squatter check
// ---------------------------------------------------------------------------

/** Reports runner.json's presence/mode and warns on broad allowedProjectDirs (mirrors scripts/install.ts). */
function checkRunnerConfig(configDir: string): void {
  const path = join(configDir, 'runner.json');
  if (!existsSync(path)) {
    warn(
      `runner.json not found (${path})`,
      'Optional: run `pnpm office:install --allow-dir <path>` to let quests/the Receptionist run in a project.',
    );
    return;
  }
  let config: { token?: unknown; allowedProjectDirs?: unknown };
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`runner.json is not valid JSON (${path})`, String((err as Error).message));
    return;
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) {
      fail(`runner.json has mode ${mode.toString(8)}, expected 600 (${path})`, `Run: chmod 600 ${path}`);
    } else {
      ok(`runner.json present, mode 600 (${path})`);
    }
  } catch (err) {
    fail(`runner.json is not readable (${path})`, String((err as Error).message));
  }
  const dirs = Array.isArray(config.allowedProjectDirs)
    ? config.allowedProjectDirs.filter((d): d is string => typeof d === 'string')
    : [];
  if (dirs.length === 0) {
    warn(
      'runner.json has no allowedProjectDirs',
      'Quests and the Receptionist project scope have nowhere to run. Add one with `--allow-dir <path>`.',
    );
  } else {
    ok(`runner.json allows ${dirs.length} project dir(s): ${dirs.join(', ')}`);
    for (const d of dirs.filter(isBroadAllowDir)) {
      warn(
        `${d} looks like a broad parent directory`,
        'It is $HOME/root, or has more than 3 git repos under it - quests/the Receptionist could run in any repo ' +
          'below it. Prefer listing individual project directories.',
      );
    }
  }
}

/** Smoke-checks the flags the runner requires on every spawn (see docs/design/runner-and-helpdesk.md §2.1). */
function checkCliCapabilities(): void {
  const res = spawnSync('claude', ['--help'], { encoding: 'utf8', timeout: 5000 });
  if (res.error || typeof res.stdout !== 'string') {
    warn('claude CLI not found (or `claude --help` failed)', 'Install/log in to Claude Code; the runner and Receptionist both spawn `claude`.');
    return;
  }
  const help = `${res.stdout}${res.stderr ?? ''}`;
  const requiredFlags = ['--setting-sources', '--strict-mcp-config', '--tools', '--restricted'];
  const missing = requiredFlags.filter((f) => !help.includes(f));
  if (missing.length === 0) {
    ok('claude --help lists --setting-sources, --strict-mcp-config, --tools and --restricted');
  } else {
    warn(
      `claude --help is missing: ${missing.join(', ')}`,
      'The runner requires all of these on every spawn; an older/newer claude CLI may need a runner update ' +
        '(see docs/design/runner-and-helpdesk.md §2.1).',
    );
  }
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (!version.error && typeof version.stdout === 'string' && version.stdout.trim()) {
    ok(`claude --version: ${version.stdout.trim()}`);
  }
}

/** Quests that can execute commands need a cgroup kill (systemd scope); see V13 in the design doc. */
function checkSystemdScope(): void {
  const res = spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--', 'true'], { timeout: 5000, stdio: 'ignore' });
  if (!res.error && res.status === 0) {
    ok('systemd-run --user --scope works (quest process containment available)');
  } else {
    warn(
      'systemd-run --user --scope is not available',
      'Quests that can execute commands (Bash rules, auto/bypassPermissions modes) are refused without it (isolation_unavailable).',
    );
  }
}

/** bubblewrap sandboxes the Receptionist; see §4.3/4.4. Its absence is a documented, non-fatal degradation. */
function checkBwrap(): void {
  const res = spawnSync('bwrap', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (!res.error && res.status === 0) {
    ok(`bwrap available (${(res.stdout || '').trim() || 'version unknown'}) - Receptionist sandboxing possible`);
  } else {
    warn(
      'bwrap not available',
      'The Receptionist falls back to --restricted alone (no filesystem sandbox); see docs/design/runner-and-helpdesk.md §4.4.',
    );
  }
}

async function checkPairingStatus(url: string): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${url.replace(/\/$/, '')}/api/auth/status`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      warn(`/api/auth/status returned HTTP ${res.status}`, 'Check server logs.');
      return;
    }
    const body = (await res.json()) as { mode?: string; admin?: boolean };
    // doctor never carries an admin token itself, so `admin: false` here is expected and not a
    // problem to flag - it says nothing about whether a browser elsewhere is paired.
    const adminNote = body.admin === true ? 'admin=true' : 'not checked without a session (normal for this CLI)';
    ok(`pairing: auth.mode=${body.mode ?? 'unknown'} (${adminNote})`);
  } catch {
    warn('could not reach /api/auth/status', 'Start the server (`pnpm office:up` or `pnpm dev`) to check pairing status.');
  }
}

/**
 * Squatter check (see docs/design/runner-and-helpdesk.md §5.2, T9): compares the direct server's
 * instanceId/version against the same fetched through the web origin (nginx/Vite dev). A mismatch
 * means something other than tagconn's server is answering on the web port's proxied API. NOTE this
 * is a residual-risk check, not a guarantee: a squatter that itself proxies /api/health would pass it.
 */
async function checkSquatter(url: string, webUrl: string, direct: HealthProbe): Promise<void> {
  if (!direct.reachable || direct.status !== 200 || !direct.body?.instanceId) {
    warn('squatter check skipped', `the server at ${url} was not reachable; re-run once it is up.`);
    return;
  }
  const web = await probeHealth(webUrl);
  if (!web.reachable) {
    warn(
      `web origin not reachable at ${webUrl}/api/health`,
      'Start the web app/proxy (`pnpm office:up` or `pnpm dev`) to run the :4318 squatter check.',
    );
    return;
  }
  if (web.status !== 200 || !web.body?.instanceId) {
    fail(`web origin at ${webUrl} did not return a usable /api/health body`, 'Check the nginx/Vite proxy config.');
    return;
  }
  if (web.body.instanceId === direct.body.instanceId && web.body.version === direct.body.version) {
    ok(`web origin (${webUrl}) matches the server's instanceId and version - no :4318 squatter detected`);
  } else {
    fail(
      `web origin (${webUrl}) reports a DIFFERENT instanceId/version than the server at ${url}`,
      'Something else may be listening on the web port. Stop it, or check `docker compose ps` / `lsof -i :4318`. ' +
        'A squatter that itself proxies /api/health would still pass this check (residual risk, §5.2).',
    );
  }
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/doctor.ts [--claude-dir <path>] [--config-dir <path>] [--url <server url>] [--web-url <web url>]',
    );
    return;
  }

  console.log('tagconn doctor\n');
  console.log(`claude dir: ${args.claudeDir}`);
  console.log(`config dir: ${args.configDir}\n`);
  checkCurl();
  checkCurlConf(args.configDir);
  checkHookScript(args.configDir);
  checkSettingsHooks(args.claudeDir);
  checkUserPermissions(args.claudeDir);
  const direct = await checkServerHealth(args.url);
  checkDockerCompose();
  checkEnvFileMode();

  console.log('\n[runner]');
  checkAttributionConf(args.configDir);
  checkRunnerConfig(args.configDir);
  checkCliCapabilities();
  checkSystemdScope();
  checkBwrap();

  console.log('\n[pairing]');
  await checkPairingStatus(args.url);
  await checkSquatter(args.url, args.webUrl, direct);

  console.log();
  if (hardFailures > 0) {
    console.log(`${hardFailures} check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log('All hard checks passed.');
  }
}

// Only run when this file is the entry point (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(`tagconn doctor failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
