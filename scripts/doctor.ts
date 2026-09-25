#!/usr/bin/env node
// tagconn doctor: sanity-checks the local install (hook, curl.conf, Claude Code
// settings, server reachability, docker compose). Prints one line per check
// and exits 1 if any hard check fails.
//
// Node 24 runs this directly (type stripping) — erasable TS syntax only,
// node: builtins only, no npm dependencies.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
    url: process.env.OFFICE_URL || 'http://127.0.0.1:4317',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--claude-dir') {
      args.claudeDir = resolve(argv[++i] ?? '');
      claudeDirExplicit = true;
    } else if (a === '--config-dir') {
      configDirFlag = resolve(argv[++i] ?? '');
    } else if (a === '--url') args.url = argv[++i] ?? args.url;
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

async function checkServerHealth(url: string): Promise<void> {
  const healthUrl = `${url.replace(/\/$/, '')}/api/health`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      ok(`server reachable at ${healthUrl}`);
    } else {
      fail(`server responded with HTTP ${res.status} at ${healthUrl}`, 'Check server logs (`pnpm office:up` or `pnpm dev`).');
    }
  } catch {
    warn(`server not reachable at ${healthUrl}`, 'Start it with `pnpm office:up` (docker) or `pnpm dev`. Hooks queue nothing while it is down.');
  }
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

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/doctor.ts [--claude-dir <path>] [--config-dir <path>] [--url <server url>]');
    return;
  }

  console.log('tagconn doctor\n');
  console.log(`claude dir: ${args.claudeDir}`);
  console.log(`config dir: ${args.configDir}\n`);
  checkCurl();
  checkCurlConf(args.configDir);
  checkHookScript(args.configDir);
  checkSettingsHooks(args.claudeDir);
  await checkServerHealth(args.url);
  checkDockerCompose();

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
  main();
}
