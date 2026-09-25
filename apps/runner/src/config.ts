// Loads and validates <configDir>/runner.json: the HOST-SIDE authority (docs/design/runner-and-helpdesk.md §2.1).
// The runner refuses to load a config that is not exactly mode 0600, not owned by the running user,
// or that fails RunnerLocalConfigSchema. It refuses to run as root outright.

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type RunnerLocalConfig, RunnerLocalConfigSchema } from '@tagconn/shared';

export class ConfigError extends Error {}

/** Default stateDir: $XDG_STATE_HOME/tagconn or ~/.local/state/tagconn (matches design §2.1). */
function defaultStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return xdg && xdg.trim() !== '' ? join(xdg, 'tagconn') : join(homedir(), '.local', 'state', 'tagconn');
}

/** Best-effort realpath: falls back to a resolved (but not symlink-verified) path if the dir does not exist yet. */
function tryRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export interface ResolvedRunnerConfig extends RunnerLocalConfig {
  /** Never optional after resolution: default filled in and directory created. */
  stateDir: string;
  /** Path the config was loaded from (for the "runnerId" persistence round-trip). */
  configPath: string;
}

/**
 * Loads `<configPath>`, checks its file mode/ownership, validates it, resolves `stateDir` and
 * realpaths `allowedProjectDirs` / `trustOverrideDirs` (the design requires realpath comparisons on
 * the runner side, never the raw string the server sends). Persists a generated `runnerId` back to
 * the file (still 0600) if one was missing.
 */
export function loadRunnerConfig(configPath: string): ResolvedRunnerConfig {
  if (platform() !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new ConfigError('the runner refuses to run as root');
  }
  const abs = resolve(configPath);
  if (!existsSync(abs)) throw new ConfigError(`runner config not found: ${abs}`);

  // POSIX permission/ownership check. Skipped on platforms without getuid (e.g. Windows dev boxes).
  if (typeof process.getuid === 'function') {
    const st = statSync(abs);
    const mode = st.mode & 0o777;
    if (mode !== 0o600) {
      throw new ConfigError(`runner config ${abs} must be mode 0600 (got ${mode.toString(8)})`);
    }
    if (st.uid !== process.getuid()) {
      throw new ConfigError(`runner config ${abs} must be owned by the running user`);
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (err) {
    throw new ConfigError(`runner config ${abs} is not valid JSON: ${(err as Error).message}`);
  }

  const parsed = RunnerLocalConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`runner config ${abs} failed validation: ${parsed.error.message}`);
  }
  const cfg = parsed.data;

  const stateDirRaw = cfg.stateDir ?? defaultStateDir();
  mkdirSync(stateDirRaw, { recursive: true, mode: 0o700 });
  const stateDir = tryRealpath(stateDirRaw);
  const allowedProjectDirs = dedupe(cfg.allowedProjectDirs.map(tryRealpath));
  const trustOverrideDirs = dedupe(cfg.trustOverrideDirs.map(tryRealpath));

  let runnerId = cfg.runnerId;
  if (!runnerId) {
    runnerId = randomUUID();
    persistRunnerId(abs, raw, runnerId);
  }

  return {
    ...cfg,
    runnerId,
    allowedProjectDirs,
    trustOverrideDirs,
    stateDir,
    configPath: abs,
  };
}

function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

/** Rewrites the config file with a generated runnerId, preserving 0600 and all other fields verbatim. */
function persistRunnerId(configPath: string, raw: unknown, runnerId: string): void {
  const next = { ...(raw as Record<string, unknown>), runnerId };
  const tmp = join(dirname(configPath), `.runner.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  // rename is atomic on the same filesystem, which configPath's directory always is.
  renameSync(tmp, configPath);
}

/** Parses `--config <path>` (and `--config=<path>`) from argv. */
export function parseCliArgs(argv: string[]): { configPath: string } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') {
      const v = argv[i + 1];
      if (!v) throw new ConfigError('--config requires a path');
      return { configPath: v };
    }
    if (a?.startsWith('--config=')) {
      return { configPath: a.slice('--config='.length) };
    }
  }
  throw new ConfigError('usage: node apps/runner/src/main.ts --config <path>');
}
