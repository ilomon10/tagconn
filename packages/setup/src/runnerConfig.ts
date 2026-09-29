import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createContext, secretOptions, touch, type SetupContext } from './context.ts';
import { ensureConfigDir } from './fsutil.ts';
import { writeSecretFile } from './secrets.ts';
import { isValidRunnerToken } from './validate.ts';

export function generateRunnerToken(): string {
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

/** True when `parent` is `child` itself, or a path component prefix of it (an ancestor). */
function isAncestorOrSelf(parent: string, child: string): boolean {
  if (parent === child) return true;
  const prefix = parent === '/' ? '/' : `${parent}/`;
  return child.startsWith(prefix);
}

/**
 * True for `/`, `$HOME`, any ancestor of `$HOME` (e.g. `/home`), or any dir with more than 3
 * git repos under it (see countGitReposBelow) - the design's examples of a "broad parent dir"
 * like `~/Projects`. Quests/the Receptionist can run in any repo under an allowed dir, so a
 * broad one effectively means "run code as me anywhere under here".
 *
 * SC4 L5: both `dir` and `$HOME` are resolved with realpathSync first, so a symlink pointing
 * at (or into) $HOME, or a trailing slash, can't be used to dodge the check the way a plain
 * string compare could. A dir that doesn't exist yet is compared as given (nothing to resolve).
 */
export function isBroadAllowDir(dir: string): boolean {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // Doesn't exist (yet): fall back to the literal path.
  }
  if (real === '/') return true;
  let realHome = homedir();
  try {
    realHome = realpathSync(realHome);
  } catch {
    // Fall back to the literal $HOME.
  }
  if (isAncestorOrSelf(real, realHome)) return true;
  return countGitReposBelow(real) > 3;
}

/** Prints a loud warning for each broad allow-dir; returns the ones flagged. */
export function warnBroadAllowDirs(dirs: string[], warn: (msg: string) => void = (m) => console.warn(m)): string[] {
  const broad = dirs.filter(isBroadAllowDir);
  for (const d of broad) {
    warn(
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
 *
 * L7 (SC5): a reinstall MERGES into an existing runner.json instead of replacing it wholesale.
 * Before this fix, re-running the installer silently dropped any field it doesn't itself manage —
 * maxPermissionMode, questToolPolicy, processIsolation, trustOverrideDirs, passEnv, etc. — resetting
 * them to the runner's built-in defaults (RunnerLocalConfigSchema) every time. Spreading `existing`
 * first, then overriding only url/token/allowedProjectDirs, keeps whatever else is there (hand-edited,
 * or written by a newer installer version this one doesn't know about). `url` is only overwritten when
 * `--url` was actually passed this run (`urlExplicit`) — otherwise the existing file's url wins, same
 * idempotence `token`/`allowedProjectDirs` already had.
 *
 * QA: `stateDir` is left unset for a DEFAULT install (`sandboxed` false), so the runner falls back to
 * its own default (`$XDG_STATE_HOME/tagconn` or `~/.local/state/tagconn`, see apps/runner/src/config.ts) -
 * unchanged behavior. For a SANDBOXED install (`args.configDirExplicit` at the call site: a `--config-dir`/
 * `TAGCONN_CONFIG_DIR`, or a non-default `--claude-dir`/`CLAUDE_CONFIG_DIR`/`--project` that derives one),
 * the runner would otherwise still default to that real, un-sandboxed state dir; this defaults `stateDir`
 * to `<configDir>/state` instead, so a runner started against a sandboxed runner.json never writes outside
 * the sandbox. Only a default (unset) `stateDir` is ever overwritten - an existing explicit value
 * (hand-edited, or from an earlier install) wins.
 */
export function ensureRunnerConfig(
  configDir: string,
  url: string,
  urlExplicit: boolean,
  allowDirsFlag: string[],
  dryRun: boolean,
  sandboxed: boolean,
  ctx: SetupContext = createContext({ dryRun }),
): RunnerConfigResult {
  const path = join(configDir, 'runner.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
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
  const resolvedUrl = urlExplicit ? url : typeof existing.url === 'string' ? existing.url : url;
  const existingStateDir = typeof existing.stateDir === 'string' ? existing.stateDir : undefined;
  const stateDir = existingStateDir ?? (sandboxed ? join(configDir, 'state') : undefined);
  const config = { ...existing, url: resolvedUrl, token, allowedProjectDirs, ...(stateDir ? { stateDir } : {}) };
  const text = JSON.stringify(config, null, 2) + '\n';
  if (dryRun) {
    ctx.log(`  [dry-run] would write ${path} (mode 600)`);
  } else {
    ensureConfigDir(ctx, configDir);
    writeSecretFile(path, text, secretOptions(ctx));
    touch(ctx, path);
    ctx.log(`  ${tokenGenerated ? 'generated new runner token' : 'kept existing runner token'}, wrote ${path}`);
  }
  if (allowedProjectDirs.length > 0) {
    ctx.log(
      '  note: quests need "hasTrustDialogAccepted" for each dir - open each allowed project once ' +
        'interactively in claude (run `claude` in that directory and accept the trust dialog) before ' +
        'starting quests there.',
    );
  } else {
    ctx.log('  no --allow-dir given: quests and the Receptionist project scope have nowhere to run yet.');
  }
  return { path, token, allowedProjectDirs, tokenGenerated };
}

/** Removes <configDir>/runner.json on uninstall. */
export function removeRunnerConfig(ctx: SetupContext, configDir: string): void {
  const path = join(configDir, 'runner.json');
  if (!existsSync(path)) return;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would remove ${path}`);
    return;
  }
  rmSync(path);
  touch(ctx, path);
  ctx.log(`  removed ${path}`);
}
