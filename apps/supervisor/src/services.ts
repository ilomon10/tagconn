import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, defaultCheckDeps, findNextFreePort, stabilizeNodePath, type CheckDeps } from '@tagconn/setup';
import { ensureDataDir } from './dataDir.ts';
import { corsOriginsFor, officeUrl, readJsonField, type ConfigStore } from './config.ts';
import { RpcFailure } from './errors.ts';
import type { LogHub } from './logHub.ts';
import { isSandboxedConfig, type Bundle, type Environment } from './paths.ts';
import type { ServiceDefinition } from './service.ts';
import type { SetupPaths } from '@tagconn/setup';

export interface DefinitionDeps {
  env: Environment;
  paths: SetupPaths;
  bundle: Bundle;
  config: ConfigStore;
  logs: LogHub;
  checkDeps?: CheckDeps;
  platform?: NodeJS.Platform;
}

/** Env vars the children must not inherit: the server reads OFFICE_*, and no service ever needs an API key. */
const STRIPPED = /^(OFFICE_|ANTHROPIC_)/;

export function cleanEnv(env: Environment): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !STRIPPED.test(k)) out[k] = v;
  return out;
}

export const dataDirOf = (deps: Pick<DefinitionDeps, 'config' | 'paths'>): string => deps.config.get().dataDir ?? deps.paths.data;

function requireFile(path: string, what: string): void {
  if (!existsSync(path)) {
    throw new RpcFailure('spawn_failed', `The ${what} is missing (${path}).`, 'This install looks incomplete or corrupt: reinstall the app.');
  }
}

/** The tokens setup wrote (hook.json, runner.json). Both are registered as log secrets. */
export function readTokens(deps: DefinitionDeps): { hook?: string; runner?: string } {
  const hook = readJsonField(join(deps.paths.config, 'hook.json'), 'token');
  const runner = readJsonField(join(deps.paths.config, 'runner.json'), 'token');
  deps.logs.addSecret(hook);
  deps.logs.addSecret(runner);
  return { hook, runner };
}

/**
 * N2: the one YAML file the desktop server reads: `<config>/office.yaml`, created empty when missing so the path is
 * always ours (`OFFICE_CONFIG` is required to exist). 'none' when it cannot be created: then no file is read at all.
 */
export function ensureOfficeConfig(deps: Pick<DefinitionDeps, 'paths' | 'logs'>): string {
  const file = join(deps.paths.config, 'office.yaml');
  try {
    mkdirSync(deps.paths.config, { recursive: true, mode: 0o700 });
    if (!existsSync(file)) writeFileSync(file, '# tagconn desktop: optional server settings (see config/office.yaml in the repo for the keys)\n', { flag: 'wx', mode: 0o600 });
    return file;
  } catch {
    deps.logs.push('supervisor', 'supervisor', `[server] could not create ${file}; the server will run with its built-in defaults`);
    return 'none';
  }
}

/** Env for the native server (design doc: OFFICE_SERVER__PORT, WEB_DIR, STORAGE__DB_PATH, tokens, runner scope). */
export function serverEnv(deps: DefinitionDeps): NodeJS.ProcessEnv {
  const cfg = deps.config.get();
  const tokens = readTokens(deps);
  const runnerReady = Boolean(tokens.runner);
  return {
    ...cleanEnv(deps.env),
    // N2: never load `.env` or `office.yaml` from cwd-relative paths; only our own file. N6: the pairing code is
    // never printed into the logs. QA K: the server exits when this supervisor dies.
    OFFICE_NO_DOTENV: '1',
    OFFICE_CONFIG: ensureOfficeConfig(deps),
    OFFICE_AUTH__LOG_PAIRING_CODE_ON_BOOT: 'false',
    TAGCONN_PARENT_PID: String(process.pid),
    OFFICE_SERVER__HOST: '127.0.0.1',
    OFFICE_SERVER__PORT: String(cfg.serverPort),
    OFFICE_SERVER__CORS_ORIGINS: JSON.stringify(corsOriginsFor(cfg.serverPort)),
    OFFICE_SERVER__WEB_DIR: deps.bundle.webDir,
    // Desktop mode: no Docker service name, so only the loopback hosts are accepted.
    OFFICE_SERVER__ALLOWED_HOSTS: JSON.stringify(['localhost', '127.0.0.1', '[::1]']),
    OFFICE_STORAGE__DB_PATH: join(dataDirOf(deps), 'office.db'),
    OFFICE_PATHS__CLAUDE_DIR: deps.paths.claudeDir,
    OFFICE_PATHS__AGENTS_DIR: join(deps.paths.claudeDir, 'agents'),
    OFFICE_PATHS__PROJECTS_DIR: join(deps.paths.claudeDir, 'projects'),
    OFFICE_RUNNER__ENABLED: String(runnerReady),
    OFFICE_RUNNER__ALLOWED_PROJECT_DIRS: JSON.stringify(cfg.allowedProjectDirs),
    ...(tokens.hook ? { OFFICE_HOOK_TOKEN: tokens.hook } : {}),
    ...(tokens.runner ? { OFFICE_RUNNER__TOKEN: tokens.runner } : {}),
  };
}

export function serverDefinition(deps: DefinitionDeps): ServiceDefinition {
  const port = () => deps.config.get().serverPort;
  return {
    id: 'server',
    marker: () => deps.bundle.serverJs,
    url: () => officeUrl(port()),
    healthUrl: () => `${officeUrl(port())}/api/health`,
    crashHint:
      'If the log mentions better-sqlite3 the install is corrupt: reinstall the app. If it mentions the port, pick another one in Settings.',
    async prepare() {
      requireFile(deps.bundle.serverJs, 'server bundle');
      const cfg = deps.config.get();
      const checkDeps = deps.checkDeps ?? defaultCheckDeps();
      const bind = await checkDeps.bindPort(cfg.serverPort);
      if (!bind.ok) {
        const next = await findNextFreePort(checkDeps, cfg.serverPort);
        throw new RpcFailure(
          'port_in_use',
          `Port ${cfg.serverPort} is not available (${bind.code}).`,
          next ? `Close the program using it, or use port ${next} in Settings.` : 'Close the program using it, or pick another port in Settings.',
        );
      }
      const dataDir = dataDirOf(deps);
      try {
        ensureDataDir(dataDir, { platform: deps.platform, env: deps.env });
      } catch (err) {
        throw new RpcFailure('spawn_failed', `Cannot create the data folder ${dataDir}: ${(err as Error).message}`, 'Choose another data folder in Settings.');
      }
      return { command: process.execPath, args: [deps.bundle.serverJs], env: serverEnv(deps), cwd: dataDir, marker: deps.bundle.serverJs };
    },
  };
}

/** The node the hook runs with (a stable copy when the current one is transient), without copying anything. */
function hookNodePathOf(deps: DefinitionDeps): string | undefined {
  try {
    const ctx = createContext({ dryRun: true, log: () => {}, warn: () => {}, platform: deps.platform, env: deps.env });
    // Same choice as setup.install: a sandboxed config dir keeps its node copy inside it.
    const nodeDir = isSandboxedConfig(deps.env, deps.platform) ? join(deps.paths.config, 'node') : undefined;
    return stabilizeNodePath(ctx, process.execPath, { nodeDir });
  } catch {
    return undefined;
  }
}

/**
 * N8: tells the runner which tagconn-owned locations quests must never touch: the data dir (database), the
 * bundle dir (a packaged install only; in a dev checkout the bundle IS the repo) and the hook's node. The runner
 * turns them into deny rules. Written at every runner start, and only when they changed.
 */
export function syncRunnerGuards(deps: DefinitionDeps): void {
  deps.config.updateRunnerJson({ dataDir: dataDirOf(deps), bundleDir: deps.bundle.dir, hookNodePath: hookNodePathOf(deps) });
}

export function runnerDefinition(deps: DefinitionDeps): ServiceDefinition {
  return {
    id: 'runner',
    marker: () => deps.bundle.runnerJs,
    crashHint: 'Check that the Claude CLI is installed and logged in (Setup check), then press Start. Watching sessions works without the runner.',
    async prepare() {
      requireFile(deps.bundle.runnerJs, 'runner bundle');
      const runnerJson = join(deps.paths.config, 'runner.json');
      if (!existsSync(runnerJson)) {
        throw new RpcFailure('spawn_failed', 'The runner is not configured yet (runner.json is missing).', 'Run the setup wizard and install the hooks first; that creates it.');
      }
      readTokens(deps);
      syncRunnerGuards(deps);
      // The runner has its own env hygiene for the claude child; it only needs the OS env (PATH, HOME, XDG_*).
      const env = { ...cleanEnv(deps.env) };
      return { command: process.execPath, args: [deps.bundle.runnerJs, '--config', runnerJson], env, cwd: deps.paths.state, marker: deps.bundle.runnerJs };
    },
  };
}

/** Env for `docker compose` (${...} substitutions in the bundled compose file). */
export function dockerEnv(deps: DefinitionDeps, version: string): NodeJS.ProcessEnv {
  const cfg = deps.config.get();
  const tokens = readTokens(deps);
  return {
    OFFICE_PORT: String(cfg.serverPort),
    TAGCONN_VERSION: version,
    TAGCONN_CLAUDE_DIR: deps.paths.claudeDir,
    OFFICE_HOOK_TOKEN: tokens.hook ?? '',
    OFFICE_RUNNER__TOKEN: tokens.runner ?? '',
    OFFICE_RUNNER__ENABLED: String(Boolean(tokens.runner)),
    OFFICE_RUNNER__ALLOWED_PROJECT_DIRS: JSON.stringify(cfg.allowedProjectDirs),
    OFFICE_SERVER__CORS_ORIGINS: JSON.stringify(corsOriginsFor(cfg.serverPort)),
  };
}
