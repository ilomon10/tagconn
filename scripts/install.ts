#!/usr/bin/env node
// tagconn installer: wires Claude Code hooks + role subagents + skills into
// ~/.claude (or a project-local .claude), and writes local hook config, the
// M8 runner's local config, and the (opt-in) attribution files.
//
// Node 24 runs this directly (type stripping) — erasable TS syntax only,
// node: builtins only, no npm dependencies. This is why the tiny constants
// and regexes below are copied from packages/shared rather than imported.
//
// Usage:
//   node scripts/install.ts [--dry-run] [--claude-dir <path>] [--config-dir <path>]
//                            [--url <server url>] [--no-agents] [--no-skills]
//                            [--project <dir>] [--repo-env-file <path>]
//                            [--attribution yes|no] [--allow-dir <path>]...
//   node scripts/install.ts --uninstall [...same flags]

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOK_MARKER = 'tagconn/office-hook.sh';
const AGENT_MARKER = '<!-- managed-by: tagconn -->';
const SKILL_MARKER = '.tagconn-managed';

// Hook token: 16-128 lowercase hex chars (matches the 24-byte hex tokens this
// installer generates, but accepts any hex secret of reasonable length).
const TOKEN_RE = /^[0-9a-f]{16,128}$/;
// Runner token (packages/shared/src/runner.ts RUNNER_TOKEN_RE): 32-128
// lowercase hex chars. Wider than the hook token because it is also used as
// an HMAC key (see docs/design/runner-and-helpdesk.md §2.2/§5.2).
const RUNNER_TOKEN_RE = /^[0-9a-f]{32,128}$/;
// Role template `name` frontmatter: used to build a filesystem path, so keep
// it to a safe slug (lowercase, digits, dashes; 2-41 chars).
const ROLE_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

/** Validates a hook token: 16-128 lowercase hex chars (see TOKEN_RE). */
export function isValidToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Validates a runner token: 32-128 lowercase hex chars (see RUNNER_TOKEN_RE). */
export function isValidRunnerToken(token: string): boolean {
  return RUNNER_TOKEN_RE.test(token);
}

/** Validates a role template's `name` frontmatter (see ROLE_NAME_RE). */
export function isValidRoleName(name: string): boolean {
  return ROLE_NAME_RE.test(name);
}

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

// Events for which Claude Code only honors a "matcher" field. The rest omit it.
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

export interface Args {
  uninstall: boolean;
  dryRun: boolean;
  claudeDir: string;
  configDir: string;
  url: string;
  noAgents: boolean;
  noSkills: boolean;
  project?: string;
  envFile: string;
  help: boolean;
  /** Explicit answer to the "write .tagconn/README.md" prompt; undefined = ask (or default no, non-interactively). */
  attribution?: 'yes' | 'no';
  /** `--allow-dir` may repeat; each becomes a runner.json `allowedProjectDirs` entry. */
  allowDirs: string[];
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
 * Resolves the config dir (holds curl.conf + the installed copy of the hook
 * script): --config-dir flag > TAGCONN_CONFIG_DIR env > derived from a
 * non-default claude dir > ~/.config/tagconn. Without this, a sandboxed
 * --claude-dir/CLAUDE_CONFIG_DIR install (or --project) would still write
 * the real ~/.config/tagconn, and two side-by-side installs would clobber
 * each other's token and hook script.
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
    uninstall: false,
    dryRun: false,
    claudeDir: envClaudeDir ? resolve(envClaudeDir) : DEFAULT_CLAUDE_DIR,
    configDir: DEFAULT_CONFIG_DIR, // resolved below, once all flags are parsed
    url: 'http://127.0.0.1:4317',
    noAgents: false,
    noSkills: false,
    project: undefined,
    envFile: join(repoRoot, '.env'),
    help: false,
    attribution: undefined,
    allowDirs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--uninstall':
        args.uninstall = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--claude-dir':
        args.claudeDir = resolve(argv[++i] ?? '');
        claudeDirExplicit = true;
        break;
      case '--config-dir':
        configDirFlag = resolve(argv[++i] ?? '');
        break;
      case '--url':
        args.url = validateUrl(argv[++i] ?? args.url);
        break;
      case '--no-agents':
        args.noAgents = true;
        break;
      case '--no-skills':
        args.noSkills = true;
        break;
      case '--project':
        args.project = resolve(argv[++i] ?? '');
        break;
      case '--repo-env-file':
        args.envFile = resolve(argv[++i] ?? args.envFile);
        break;
      case '--attribution': {
        const v = argv[++i];
        if (v !== 'yes' && v !== 'no') {
          console.error(`--attribution must be "yes" or "no" (got ${JSON.stringify(v)})`);
          args.help = true;
          break;
        }
        args.attribution = v;
        break;
      }
      case '--allow-dir':
        args.allowDirs.push(resolve(argv[++i] ?? ''));
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        args.help = true;
    }
  }
  // --project installs hooks into <dir>/.claude instead of the user-level dir.
  if (args.project) {
    args.claudeDir = join(args.project, '.claude');
    claudeDirExplicit = true;
  }

  // See resolveConfigDir for the precedence.
  args.configDir = resolveConfigDir({
    configDirFlag,
    configDirEnv: process.env.TAGCONN_CONFIG_DIR,
    claudeDirExplicit,
    claudeDir: args.claudeDir,
  });
  validateNoSingleQuote(args.configDir, '--config-dir');
  return args;
}

/**
 * Rejects a path containing a single quote: the config dir is embedded,
 * single-quoted, in the hook command written to settings.json (see
 * `ourCommand`), so a stray `'` would break out of the quoting.
 */
export function validateNoSingleQuote(path: string, label: string): void {
  if (path.includes("'")) {
    throw new Error(`${label} must not contain a single quote (got ${JSON.stringify(path)})`);
  }
}

/** Validates a server URL: http(s) only, no whitespace/quotes, parseable by `new URL()`. */
export function validateUrl(raw: string): string {
  if (/["'\s]/.test(raw)) {
    throw new Error(`--url is invalid: must not contain whitespace or quotes (got ${JSON.stringify(raw)})`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`--url is invalid: ${JSON.stringify(raw)} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`--url must use http or https (got ${JSON.stringify(parsed.protocol)})`);
  }
  return raw.replace(/\/+$/, '');
}

function printHelp(): void {
  console.log(`tagconn installer

Usage:
  node scripts/install.ts [options]
  node scripts/install.ts --uninstall [options]

Options:
  --uninstall            Remove tagconn hooks, agents and skills (only ours).
  --dry-run              Print what would change without writing anything.
  --claude-dir <path>    Claude config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude).
  --config-dir <path>    Dir for curl.conf + the installed hook script (default:
                          $TAGCONN_CONFIG_DIR, or derived from a non-default --claude-dir /
                          CLAUDE_CONFIG_DIR / --project, or ~/.config/tagconn).
  --project <dir>        Install into <dir>/.claude instead of the user-level dir.
  --url <server url>     Office server URL (default: http://127.0.0.1:4317).
  --no-agents            Skip installing role subagents.
  --no-skills            Skip installing skills.
  --repo-env-file <path> Repo .env path to read/write (default: <repo>/.env).
  --attribution yes|no   Write .tagconn/README.md into git repos you open (default: ask
                          interactively, or "no" when not run in a terminal).
  --allow-dir <path>     A directory quests/the Receptionist may run in (repeatable).
                          Written to runner.json's allowedProjectDirs. Broad parents
                          ($HOME, or a dir with many git repos under it) print a warning.
  --help                 Show this help.
`);
}

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

function log(msg: string): void {
  console.log(msg);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Atomic JSON write: write to a sibling temp file (exclusive create), then rename over the target. */
function writeJsonAtomic(path: string, value: unknown, dryRun: boolean): void {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (dryRun) {
    log(`  [dry-run] would write ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${basenameOf(path)}.tagconn-tmp-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmpPath, text, { encoding: 'utf8', flag: 'wx' });
  renameSync(tmpPath, path);
}

function basenameOf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

/** Writes a secret file (mode 600 from the moment it exists) and re-asserts the mode afterward. */
function writeSecretFile(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function ensureDir(path: string, dryRun: boolean): void {
  if (dryRun) return;
  mkdirSync(path, { recursive: true });
}

/** Ensures the config dir exists, mode 700, and not dry-run. */
function ensureConfigDir(configDir: string, dryRun: boolean): string {
  if (!dryRun) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    chmodSync(configDir, 0o700);
  }
  return configDir;
}

// ---------------------------------------------------------------------------
// .env handling (repo .env from .env.example, plus <configDir>/curl.conf)
// ---------------------------------------------------------------------------

export function parseEnvFile(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

export function upsertEnvLine(lines: string[], key: string, value: string): string[] {
  const prefix = `${key}=`;
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  const newLine = `${key}=${value}`;
  if (idx === -1) {
    return [...lines, newLine];
  }
  const copy = [...lines];
  copy[idx] = newLine;
  return copy;
}

function generateToken(): string {
  return randomBytes(24).toString('hex');
}

/** Ensures the repo .env exists (seeded from .env.example) and has a hook token. Returns the token. */
function ensureRepoEnv(envFile: string, dryRun: boolean): string {
  const exampleFile = join(repoRoot, '.env.example');
  let text: string;
  if (existsSync(envFile)) {
    text = readFileSync(envFile, 'utf8');
  } else if (existsSync(exampleFile)) {
    text = readFileSync(exampleFile, 'utf8');
  } else {
    text = 'OFFICE_HOOK_TOKEN=\nOFFICE_PORT=4317\nOFFICE_WEB_PORT=4318\n';
  }
  const parsed = parseEnvFile(text);
  let token = parsed.get('OFFICE_HOOK_TOKEN') || '';
  let lines = text.split('\n');
  // Drop a trailing empty line so upsert doesn't accumulate blank lines.
  if (lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);

  if (!token) {
    token = generateToken();
    lines = upsertEnvLine(lines, 'OFFICE_HOOK_TOKEN', token);
    log(`  generated new OFFICE_HOOK_TOKEN`);
  } else if (!isValidToken(token)) {
    throw new Error(
      `OFFICE_HOOK_TOKEN in ${envFile} is invalid: must match ${TOKEN_RE} (16-128 lowercase hex chars). ` +
        `Fix it, or clear the line and re-run to generate a new one.`,
    );
  } else {
    log(`  kept existing OFFICE_HOOK_TOKEN`);
  }

  const newText = lines.join('\n') + '\n';
  if (dryRun) {
    log(`  [dry-run] would write ${envFile} (mode 600)`);
  } else {
    mkdirSync(dirname(envFile), { recursive: true });
    writeSecretFile(envFile, newText);
    log(`  wrote ${envFile}`);
  }
  return token;
}

/**
 * Writes <configDir>/curl.conf, mode 600: a curl `-K` config file holding the
 * shared secret and target URL, so the hook never puts the token on a
 * command line (visible to any local user via `ps`).
 */
function ensureCurlConf(configDir: string, token: string, url: string, dryRun: boolean): string {
  const confPath = join(configDir, 'curl.conf');
  const content =
    `# Written by tagconn scripts/install.ts. Contains the hook's shared secret -\n` +
    `# mode 600, read by curl -K, never passed on a command line.\n` +
    `header = "x-office-token: ${token}"\n` +
    `url = "${url}/api/hooks"\n`;
  if (dryRun) {
    log(`  [dry-run] would write ${confPath} (mode 600)`);
    return confPath;
  }
  ensureConfigDir(configDir, dryRun);
  writeSecretFile(confPath, content);
  log(`  wrote ${confPath}`);
  return confPath;
}

/** Removes <configDir>/curl.conf (holds the shared secret) on uninstall. */
function removeCurlConf(configDir: string, dryRun: boolean): void {
  const confPath = join(configDir, 'curl.conf');
  if (!existsSync(confPath)) return;
  if (dryRun) {
    log(`  [dry-run] would remove ${confPath}`);
    return;
  }
  rmSync(confPath);
  log(`  removed ${confPath}`);
}

/** Removes the legacy shell-sourced hook.env, superseded by curl.conf (MED-5 / LOW-1). */
function removeLegacyHookEnv(configDir: string, dryRun: boolean): void {
  const legacyPath = join(configDir, 'hook.env');
  if (!existsSync(legacyPath)) return;
  if (dryRun) {
    log(`  [dry-run] would remove legacy ${legacyPath} (superseded by curl.conf)`);
    return;
  }
  rmSync(legacyPath);
  log(`  removed legacy ${legacyPath} (superseded by curl.conf)`);
}

function ensureHookScript(configDir: string, dryRun: boolean): string {
  const dest = join(configDir, 'office-hook.sh');
  const src = join(repoRoot, 'packages', 'hook', 'office-hook.sh');
  if (dryRun) {
    log(`  [dry-run] would copy ${src} -> ${dest} (mode 755)`);
    return dest;
  }
  ensureConfigDir(configDir, dryRun);
  cpSync(src, dest);
  chmodSync(dest, 0o755);
  log(`  installed hook script at ${dest}`);
  return dest;
}

// ---------------------------------------------------------------------------
// attribution (M8 8j): the opt-in .tagconn/README.md template, and the
// (default-on) attribution.conf the hook uses to POST office.json imports.
// See docs/design/runner-and-helpdesk.md §6.2.
// ---------------------------------------------------------------------------

/**
 * Asks whether to enable README writes. `explicit` (from `--attribution`) always wins.
 * Otherwise: prompts interactively when stdin is a TTY (default answer: no); everywhere
 * else (CI, tests, piped input) it defaults to "no" without blocking on input.
 */
export async function promptAttribution(explicit: 'yes' | 'no' | undefined): Promise<boolean> {
  if (explicit === 'yes') return true;
  if (explicit === 'no') return false;
  if (!process.stdin.isTTY) {
    log('  no --attribution flag and not an interactive terminal: defaulting to "no"');
    return false;
  }
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (
      await rl.question('Write a small .tagconn/README.md into git repos you open with Claude Code? [y/N] ')
    )
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Installs the opt-in README template; the hook only ever writes .tagconn/README.md when this exists. */
function installAttributionReadme(configDir: string, dryRun: boolean): string {
  const dest = join(configDir, 'attribution-README.md');
  const src = join(repoRoot, 'packages', 'agent-templates', 'attribution', 'README.md.tmpl');
  if (dryRun) {
    log(`  [dry-run] would copy ${src} -> ${dest}`);
    return dest;
  }
  ensureConfigDir(configDir, dryRun);
  cpSync(src, dest);
  log(`  installed ${dest} (the hook will write .tagconn/README.md into repos you open)`);
  return dest;
}

/** Removes the opt-in README template, so the hook stops writing .tagconn/README.md. */
function removeAttributionReadme(configDir: string, dryRun: boolean): void {
  const dest = join(configDir, 'attribution-README.md');
  if (!existsSync(dest)) return;
  if (dryRun) {
    log(`  [dry-run] would remove ${dest}`);
    return;
  }
  rmSync(dest);
  log(`  removed ${dest}`);
}

/**
 * Writes <configDir>/attribution.conf, mode 600: a curl `-K` config pointed at the
 * import endpoint, reusing the hook token (same "hook" access level as /api/hooks).
 * Installed by default - unlike the README template, importing writes nothing to the
 * repo and the server always asks before applying an import (settings.attribution.autoImport).
 */
function ensureAttributionConf(configDir: string, token: string, url: string, dryRun: boolean): string {
  const confPath = join(configDir, 'attribution.conf');
  const content =
    `# Written by tagconn scripts/install.ts. Used by the hook to POST\n` +
    `# .tagconn/office.json profiles for import - mode 600, read by curl -K.\n` +
    `header = "x-office-token: ${token}"\n` +
    `url = "${url}/api/attribution/import"\n`;
  if (dryRun) {
    log(`  [dry-run] would write ${confPath} (mode 600)`);
    return confPath;
  }
  ensureConfigDir(configDir, dryRun);
  writeSecretFile(confPath, content);
  log(`  wrote ${confPath}`);
  return confPath;
}

/** Removes <configDir>/attribution.conf on uninstall. */
function removeAttributionConf(configDir: string, dryRun: boolean): void {
  const confPath = join(configDir, 'attribution.conf');
  if (!existsSync(confPath)) return;
  if (dryRun) {
    log(`  [dry-run] would remove ${confPath}`);
    return;
  }
  rmSync(confPath);
  log(`  removed ${confPath}`);
}

// ---------------------------------------------------------------------------
// runner (M8 8k): <configDir>/runner.json, the host-side authority for quests
// and the Receptionist. See docs/design/runner-and-helpdesk.md §2.1.
// ---------------------------------------------------------------------------

function generateRunnerToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Counts (up to `cap`) directories at or below `dir`, within `maxDepth` levels, that
 * contain a `.git` entry - a cheap proxy for "this allowed dir holds many separate
 * repos", which matters because quests/the Receptionist may run in ANY repo under an
 * allowed dir. Skips dotfiles/node_modules, and gives up after `budget` directories
 * visited so a huge tree can't make the installer hang.
 */
export function countGitReposBelow(dir: string, maxDepth = 2, cap = 4, budget = 2000): number {
  let count = 0;
  let visited = 0;
  const visit = (d: string, depth: number): void => {
    if (count >= cap || visited >= budget) return;
    visited++;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    if (entries.includes('.git')) count++;
    if (count >= cap || depth >= maxDepth) return;
    for (const e of entries) {
      if (visited >= budget) return;
      if (e === '.git' || e === 'node_modules' || e.startsWith('.')) continue;
      const full = join(d, e);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) visit(full, depth + 1);
      if (count >= cap) return;
    }
  };
  visit(dir, 0);
  return count;
}

/**
 * True for `$HOME`, `/`, or any dir with more than 3 git repos under it (see
 * countGitReposBelow) - the design's examples of a "broad parent dir" like `~/Projects`.
 * Quests/the Receptionist can run in any repo under an allowed dir, so a broad one
 * effectively means "run code as me anywhere under here".
 */
export function isBroadAllowDir(dir: string): boolean {
  if (dir === homedir() || dir === '/') return true;
  return countGitReposBelow(dir) > 3;
}

/** Prints a loud warning for each broad allow-dir; returns the ones flagged. */
export function warnBroadAllowDirs(dirs: string[]): string[] {
  const broad = dirs.filter(isBroadAllowDir);
  for (const d of broad) {
    console.warn(
      `  WARNING: ${d} looks like a broad parent directory (it is $HOME/root, or has more than 3 git ` +
        `repos under it). Quests and the Receptionist can run Claude Code as you in ANY repo below an ` +
        `allowed dir - prefer listing individual project directories with --allow-dir instead.`,
    );
  }
  return broad;
}

export interface RunnerConfigResult {
  path: string;
  token: string;
  allowedProjectDirs: string[];
  tokenGenerated: boolean;
}

/**
 * Writes <configDir>/runner.json, mode 600 (RunnerLocalConfigSchema in packages/shared;
 * only the fields the installer knows about are set here, the runner fills the rest
 * with its own defaults). Idempotent: keeps the existing token, and keeps the existing
 * allowedProjectDirs when no --allow-dir was passed this run.
 */
function ensureRunnerConfig(configDir: string, url: string, allowDirsFlag: string[], dryRun: boolean): RunnerConfigResult {
  const path = join(configDir, 'runner.json');
  let existing: { token?: unknown; allowedProjectDirs?: unknown } = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      existing = {};
    }
  }
  let token = typeof existing.token === 'string' ? existing.token : '';
  let tokenGenerated = false;
  if (!token || !isValidRunnerToken(token)) {
    token = generateRunnerToken();
    tokenGenerated = true;
  }
  const allowedProjectDirs =
    allowDirsFlag.length > 0
      ? allowDirsFlag
      : Array.isArray(existing.allowedProjectDirs)
        ? existing.allowedProjectDirs.filter((d): d is string => typeof d === 'string')
        : [];
  const config = { url, token, allowedProjectDirs };
  const text = JSON.stringify(config, null, 2) + '\n';
  if (dryRun) {
    log(`  [dry-run] would write ${path} (mode 600)`);
  } else {
    ensureConfigDir(configDir, dryRun);
    writeSecretFile(path, text);
    log(`  ${tokenGenerated ? 'generated new runner token' : 'kept existing runner token'}, wrote ${path}`);
  }
  if (allowedProjectDirs.length > 0) {
    log(
      '  note: quests need "hasTrustDialogAccepted" for each dir - open each allowed project once ' +
        'interactively in claude (run `claude` in that directory and accept the trust dialog) before ' +
        'starting quests there.',
    );
  } else {
    log('  no --allow-dir given: quests and the Receptionist project scope have nowhere to run yet.');
  }
  return { path, token, allowedProjectDirs, tokenGenerated };
}

/** Removes <configDir>/runner.json on uninstall. */
function removeRunnerConfig(configDir: string, dryRun: boolean): void {
  const path = join(configDir, 'runner.json');
  if (!existsSync(path)) return;
  if (dryRun) {
    log(`  [dry-run] would remove ${path}`);
    return;
  }
  rmSync(path);
  log(`  removed ${path}`);
}

/** Upserts OFFICE_RUNNER__TOKEN into the repo .env (same file/convention as OFFICE_HOOK_TOKEN). */
function ensureRunnerTokenEnv(envFile: string, runnerToken: string, dryRun: boolean): void {
  const text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  let lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  lines = upsertEnvLine(lines, 'OFFICE_RUNNER__TOKEN', runnerToken);
  const newText = lines.join('\n') + '\n';
  if (dryRun) {
    log(`  [dry-run] would set OFFICE_RUNNER__TOKEN in ${envFile}`);
    return;
  }
  writeSecretFile(envFile, newText);
  log(`  set OFFICE_RUNNER__TOKEN in ${envFile}`);
}

// ---------------------------------------------------------------------------
// settings.json hook merge
// ---------------------------------------------------------------------------

export type HookEntry = { type: string; command: string; [k: string]: unknown };
export type MatcherGroup = { matcher?: string; hooks: HookEntry[]; [k: string]: unknown };
export type SettingsJson = { hooks?: Record<string, MatcherGroup[]>; [k: string]: unknown };

export function isOurCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  if (command.includes(HOOK_MARKER)) return true;
  // Non-default config dir form (see `ourCommand`): the config dir need not
  // be named "tagconn" (a custom --config-dir), so also match on our
  // distinctive env var name plus the script name.
  return command.includes('TAGCONN_CURL_CONF=') && command.includes('office-hook.sh');
}

export function ourCommand(hookScriptPath: string, confPath: string, isDefaultConfigDir: boolean): string {
  if (isDefaultConfigDir) {
    // Quote in case the path contains spaces (e.g. a HOME with spaces).
    return `"${hookScriptPath}"`;
  }
  // Non-default config dir: the hook script's own default
  // ($HOME/.config/tagconn/curl.conf) would be wrong here, so point it at
  // its conf file explicitly. Paths are single-quoted and were validated
  // (validateNoSingleQuote) to contain no single quote.
  return `TAGCONN_CURL_CONF='${confPath}' '${hookScriptPath}'`;
}

function backupSettings(path: string, dryRun: boolean): void {
  if (!existsSync(path)) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.tagconn-backup-${ts}`;
  if (dryRun) {
    log(`  [dry-run] would back up ${path} -> ${backupPath}`);
    return;
  }
  cpSync(path, backupPath);
  log(`  backed up settings to ${backupPath}`);
}

function loadSettings(path: string): SettingsJson {
  if (!existsSync(path)) return {};
  try {
    return readJson(path) as SettingsJson;
  } catch (err) {
    throw new Error(`Failed to parse ${path} as JSON: ${(err as Error).message}`);
  }
}

export function installHooks(
  settings: SettingsJson,
  hookScriptPath: string,
  confPath: string,
  isDefaultConfigDir: boolean,
): { added: number; skipped: number } {
  settings.hooks = settings.hooks || {};
  const command = ourCommand(hookScriptPath, confPath, isDefaultConfigDir);
  let added = 0;
  let skipped = 0;
  for (const event of HOOK_EVENTS) {
    const groups = settings.hooks[event] || [];
    settings.hooks[event] = groups;
    const alreadyPresent = groups.some((g) => (g.hooks || []).some((h) => isOurCommand(h.command)));
    if (alreadyPresent) {
      skipped++;
      continue;
    }
    const entry: HookEntry = { type: 'command', command };
    if (MATCHER_EVENTS.has(event)) {
      // Append to an existing "*" matcher group if present, else create one.
      const starGroup = groups.find((g) => g.matcher === '*');
      if (starGroup) {
        starGroup.hooks = [...(starGroup.hooks || []), entry];
      } else {
        groups.push({ matcher: '*', hooks: [entry] });
      }
    } else {
      groups.push({ hooks: [entry] });
    }
    added++;
  }
  return { added, skipped };
}

export function uninstallHooks(settings: SettingsJson): { removed: number } {
  if (!settings.hooks) return { removed: 0 };
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event] || [];
    const nextGroups: MatcherGroup[] = [];
    for (const group of groups) {
      const filteredHooks = (group.hooks || []).filter((h) => {
        const ours = isOurCommand(h.command);
        if (ours) removed++;
        return !ours;
      });
      if (filteredHooks.length > 0) {
        nextGroups.push({ ...group, hooks: filteredHooks });
      }
    }
    if (nextGroups.length > 0) {
      settings.hooks[event] = nextGroups;
    } else {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  return { removed };
}

// ---------------------------------------------------------------------------
// frontmatter parsing (hand-written; no deps)
// ---------------------------------------------------------------------------

export interface ParsedTemplate {
  frontmatter: Record<string, string>;
  body: string;
}

export function parseFrontmatter(text: string): ParsedTemplate {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: {}, body: text };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { frontmatter: {}, body: text };
  }
  const frontmatter: Record<string, string> = {};
  for (const raw of lines.slice(1, end)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { frontmatter, body };
}

/** True when a frontmatter boolean-ish value spells out "false". */
export function isExplicitFalse(value: string | undefined): boolean {
  return value === 'false' || value === 'no' || value === '0';
}

// ---------------------------------------------------------------------------
// role subagents
// ---------------------------------------------------------------------------

const CLAUDE_FRONTMATTER_KEYS = ['name', 'description', 'tools', 'model'];

/**
 * Renders a role template's frontmatter + body into a Claude Code agent
 * file: keeps only the frontmatter keys Claude Code understands (name,
 * description, tools, model - drops tagconn's office-* keys), re-quotes
 * values that need it, and appends the managed-by marker.
 */
export function buildAgentFile(frontmatter: Record<string, string>, body: string): string {
  const outFrontmatterLines = CLAUDE_FRONTMATTER_KEYS.filter((k) => frontmatter[k] !== undefined).map((k) => {
    const v = frontmatter[k] as string;
    // Re-quote values that need it (description usually does).
    const needsQuote = /:/.test(v) && !(v.startsWith('"') || v.startsWith("'"));
    return needsQuote ? `${k}: "${v.replace(/"/g, '\\"')}"` : `${k}: ${v}`;
  });
  return `---\n${outFrontmatterLines.join('\n')}\n---\n${body.replace(/\s*$/, '')}\n\n${AGENT_MARKER}\n`;
}

function installAgents(claudeDir: string, dryRun: boolean): void {
  const rolesDir = join(repoRoot, 'packages', 'agent-templates', 'roles');
  const agentsDir = join(claudeDir, 'agents');
  if (!existsSync(rolesDir)) {
    log('  no role templates found, skipping');
    return;
  }
  ensureDir(agentsDir, dryRun);
  const files = readdirSync(rolesDir).filter((f) => f.endsWith('.md'));
  let written = 0;
  let skippedDisabled = 0;
  let skippedUnmanaged = 0;
  let skippedInvalidName = 0;
  for (const file of files) {
    const src = join(rolesDir, file);
    const raw = readFileSync(src, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    if (isExplicitFalse(frontmatter['office-enabled']) || isExplicitFalse(frontmatter['office-sync'])) {
      skippedDisabled++;
      continue;
    }
    const name = frontmatter['name'] || file.replace(/\.md$/, '');
    if (!isValidRoleName(name)) {
      console.warn(`  WARNING: skipping ${file} - invalid role name ${JSON.stringify(name)} (must match ${ROLE_NAME_RE})`);
      skippedInvalidName++;
      continue;
    }
    const destPath = join(agentsDir, `${name}.md`);
    if (existsSync(destPath)) {
      const existing = readFileSync(destPath, 'utf8');
      if (!existing.includes(AGENT_MARKER)) {
        console.warn(`  WARNING: skipping ${destPath} - exists and is not managed by tagconn`);
        skippedUnmanaged++;
        continue;
      }
    }
    const out = buildAgentFile(frontmatter, body);
    if (dryRun) {
      log(`  [dry-run] would write ${destPath}`);
    } else {
      writeFileSync(destPath, out, 'utf8');
    }
    written++;
  }
  log(
    `  agents: ${written} written, ${skippedDisabled} disabled by template, ${skippedUnmanaged} skipped (unmanaged file exists), ${skippedInvalidName} skipped (invalid name)`,
  );
}

function uninstallAgents(claudeDir: string, dryRun: boolean): void {
  const agentsDir = join(claudeDir, 'agents');
  if (!existsSync(agentsDir)) return;
  let removed = 0;
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith('.md')) continue;
    const path = join(agentsDir, file);
    const content = readFileSync(path, 'utf8');
    if (content.includes(AGENT_MARKER)) {
      if (dryRun) {
        log(`  [dry-run] would remove ${path}`);
      } else {
        rmSync(path);
      }
      removed++;
    }
  }
  log(`  agents: removed ${removed} managed file(s)`);
}

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

function installSkills(claudeDir: string, dryRun: boolean): void {
  const skillsSrcDir = join(repoRoot, 'packages', 'agent-templates', 'skills');
  const skillsDestDir = join(claudeDir, 'skills');
  if (!existsSync(skillsSrcDir)) {
    log('  no skill templates found, skipping');
    return;
  }
  ensureDir(skillsDestDir, dryRun);
  const skills = readdirSync(skillsSrcDir).filter((f) => statSync(join(skillsSrcDir, f)).isDirectory());
  let written = 0;
  let skippedUnmanaged = 0;
  for (const skill of skills) {
    const src = join(skillsSrcDir, skill);
    const dest = join(skillsDestDir, skill);
    if (existsSync(dest) && !existsSync(join(dest, SKILL_MARKER))) {
      console.warn(`  WARNING: skipping ${dest} - exists and is not managed by tagconn`);
      skippedUnmanaged++;
      continue;
    }
    if (dryRun) {
      log(`  [dry-run] would copy ${src} -> ${dest}`);
    } else {
      cpSync(src, dest, { recursive: true });
      writeFileSync(join(dest, SKILL_MARKER), '', 'utf8');
    }
    written++;
  }
  log(`  skills: ${written} written, ${skippedUnmanaged} skipped (unmanaged dir exists)`);
}

function uninstallSkills(claudeDir: string, dryRun: boolean): void {
  const skillsDestDir = join(claudeDir, 'skills');
  if (!existsSync(skillsDestDir)) return;
  let removed = 0;
  for (const entry of readdirSync(skillsDestDir)) {
    const dest = join(skillsDestDir, entry);
    if (!statSync(dest).isDirectory()) continue;
    if (existsSync(join(dest, SKILL_MARKER))) {
      if (dryRun) {
        log(`  [dry-run] would remove ${dest}`);
      } else {
        rmSync(dest, { recursive: true, force: true });
      }
      removed++;
    }
  }
  log(`  skills: removed ${removed} managed dir(s)`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const settingsPath = join(args.claudeDir, 'settings.json');
  const isDefaultConfigDir = args.configDir === DEFAULT_CONFIG_DIR;
  log(`tagconn ${args.uninstall ? 'uninstall' : 'install'}`);
  log(`  claude dir: ${args.claudeDir}`);
  log(`  config dir: ${args.configDir}`);
  if (args.dryRun) log('  (dry run - no files will be written)');

  if (args.uninstall) {
    log('\n[settings.json]');
    backupSettings(settingsPath, args.dryRun);
    const settings = loadSettings(settingsPath);
    const { removed } = uninstallHooks(settings);
    writeJsonAtomic(settingsPath, settings, args.dryRun);
    log(`  removed ${removed} tagconn hook entr${removed === 1 ? 'y' : 'ies'}`);

    if (!args.noAgents) {
      log('\n[agents]');
      uninstallAgents(args.claudeDir, args.dryRun);
    }
    if (!args.noSkills) {
      log('\n[skills]');
      uninstallSkills(args.claudeDir, args.dryRun);
    }

    log('\n[hook config]');
    removeCurlConf(args.configDir, args.dryRun);
    removeLegacyHookEnv(args.configDir, args.dryRun);

    log('\n[attribution]');
    removeAttributionReadme(args.configDir, args.dryRun);
    removeAttributionConf(args.configDir, args.dryRun);

    log('\n[runner]');
    removeRunnerConfig(args.configDir, args.dryRun);

    log('\ntagconn uninstalled. The hook script and .env were left in place;');
    log(`remove ${args.configDir} manually if you want the hook script gone too.`);
    return;
  }

  log('\n[.env]');
  const token = ensureRepoEnv(args.envFile, args.dryRun);

  log('\n[hook config]');
  const confPath = ensureCurlConf(args.configDir, token, args.url, args.dryRun);
  removeLegacyHookEnv(args.configDir, args.dryRun);
  const hookScriptPath = ensureHookScript(args.configDir, args.dryRun);

  log('\n[attribution]');
  ensureAttributionConf(args.configDir, token, args.url, args.dryRun);
  const wantsReadme = await promptAttribution(args.attribution);
  if (wantsReadme) {
    installAttributionReadme(args.configDir, args.dryRun);
  } else {
    removeAttributionReadme(args.configDir, args.dryRun);
    log('  README writes disabled (opt in with --attribution yes, or answer "y" at the prompt)');
  }

  log('\n[runner]');
  const runnerConfig = ensureRunnerConfig(args.configDir, args.url, args.allowDirs, args.dryRun);
  warnBroadAllowDirs(runnerConfig.allowedProjectDirs);
  ensureRunnerTokenEnv(args.envFile, runnerConfig.token, args.dryRun);

  log('\n[settings.json]');
  backupSettings(settingsPath, args.dryRun);
  const settings = loadSettings(settingsPath);
  const { added, skipped } = installHooks(settings, hookScriptPath, confPath, isDefaultConfigDir);
  writeJsonAtomic(settingsPath, settings, args.dryRun);
  log(`  hooks: ${added} added, ${skipped} already present`);

  if (!args.noAgents) {
    log('\n[agents]');
    installAgents(args.claudeDir, args.dryRun);
  } else {
    log('\n[agents] skipped (--no-agents)');
  }

  if (!args.noSkills) {
    log('\n[skills]');
    installSkills(args.claudeDir, args.dryRun);
  } else {
    log('\n[skills] skipped (--no-skills)');
  }

  log('\ntagconn installed.');
  log(`  server url: ${args.url}`);
  log(`  config dir: ${args.configDir}`);
  log(`  hook script: ${hookScriptPath}`);
  log(`  settings: ${settingsPath}`);
  log('\nNext: start the server (pnpm office:up, or pnpm dev), then run `claude` in any project.');
  log('Run `node scripts/doctor.ts` to verify the install.');
}

// Only run when this file is the entry point (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(`tagconn install failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
