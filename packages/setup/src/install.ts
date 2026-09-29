import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { installClaudeHooks, loadSettings, uninstallClaudeHooks, type HookSpec, type HookKind } from './claudeSettings.ts';
import { createContext, type SetupContext } from './context.ts';
import { ensureRepoEnv, ensureRunnerTokenEnv, generateToken } from './env.ts';
import {
  ensureAttributionConf,
  ensureCurlConf,
  ensureHookScript,
  ensureServerUrlFile,
  installAttributionReadme,
  removeAttributionConf,
  removeAttributionReadme,
  removeCurlConf,
  removeLegacyHookEnv,
  removeServerUrlFile,
} from './hookFiles.ts';
import { installNodeHookScript, readHookConfigToken, removeHookConfig, writeHookConfig } from './hookConfig.ts';
import { resolveSetupPaths } from './paths.ts';
import { ensureRunnerConfig, removeRunnerConfig, warnBroadAllowDirs } from './runnerConfig.ts';
import { installAgents, installSkills, uninstallAgents, uninstallSkills } from './templates.ts';
import type { InstallResult } from './types.ts';
import { isValidToken } from './validate.ts';

export interface InstallOptions {
  claudeDir: string;
  configDir: string;
  url: string;
  /** True only if the operator explicitly passed a URL (so a reinstall may overwrite runner.json's url). */
  urlExplicit: boolean;
  noAgents: boolean;
  noSkills: boolean;
  /** The repo .env (CLI). null = no repo .env (desktop): the token lives in hook.json / runner.json only. */
  envFile: string | null;
  /** Hook token to use when there is no envFile; default: the one already in hook.json, else a new one. */
  token?: string;
  allowDirs: string[];
  /** The operator asked for a non-default location (a sandboxed run): runner.json gets a sandboxed stateDir. */
  configDirExplicit: boolean;
  /** Which hook to register in settings.json. */
  hook: HookKind;
  /** The node executable for the node hook (exec form). Default: process.execPath. */
  nodePath?: string;
  /** Write .tagconn/README.md into repos? Resolved lazily so the CLI can prompt at the right point of the output. */
  attribution: boolean | (() => Promise<boolean> | boolean);
  /** Whether configDir is the OS default (the sh hook then needs no TAGCONN_CURL_CONF prefix). */
  isDefaultConfigDir: boolean;
}

export interface UninstallOptions {
  claudeDir: string;
  configDir: string;
  noAgents: boolean;
  noSkills: boolean;
}

/** The OS-default config dir for `isDefaultConfigDir` (POSIX keeps ~/.config/tagconn, as the sh hook expects). */
export function defaultConfigDirFor(ctx: SetupContext): string {
  return resolveSetupPaths({ platform: ctx.platform, env: ctx.env, legacyPosixConfig: true }).config;
}

/**
 * Asks whether to enable README writes. `explicit` (from `--attribution`) always wins.
 * Otherwise: prompts interactively when stdin is a TTY (default answer: no); everywhere
 * else (CI, tests, piped input) it defaults to "no" without blocking on input.
 */
export async function promptAttribution(
  explicit: 'yes' | 'no' | undefined,
  log: (msg: string) => void = (m) => console.log(m),
): Promise<boolean> {
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

/**
 * Installs hooks, role agents, skills and the local config. Every step is idempotent. A failure while writing
 * settings.json rolls it back from the backup (SettingsRollbackError); a secret file that cannot be locked
 * down throws SecretFileError before anything depends on it. Returns what changed for the "what changed" summary.
 */
export async function install(opts: InstallOptions, ctxIn?: SetupContext): Promise<InstallResult> {
  const ctx = ctxIn ?? createContext();
  const settingsPath = join(opts.claudeDir, 'settings.json');
  const nodePath = opts.nodePath ?? process.execPath;

  // Fail before writing anything (secrets included) if settings.json can't be merged into safely,
  // or if a directory we must write into isn't writable: no half-finished installs.
  loadSettings(settingsPath);
  if (!ctx.dryRun) {
    assertWritableDir(opts.configDir);
    assertWritableDir(opts.claudeDir);
  }

  // Token: the repo .env is the source of truth for the CLI; without one, keep hook.json's, else generate.
  let token: string;
  if (opts.envFile) {
    ctx.log('\n[.env]');
    token = ensureRepoEnv(ctx, opts.envFile);
  } else {
    const existing = opts.token ?? readHookConfigToken(opts.configDir);
    if (opts.token !== undefined && !isValidToken(opts.token)) {
      throw new Error('The hook token is invalid: it must be 16-128 lowercase hex chars.');
    }
    token = existing && isValidToken(existing) ? existing : generateToken();
  }

  ctx.log('\n[hook config]');
  let spec: HookSpec;
  let readmeFromHookJson: (wants: boolean) => void = () => {};
  if (opts.hook === 'node') {
    const scriptPath = installNodeHookScript(ctx, opts.configDir);
    spec = { kind: 'node', nodePath, scriptPath };
    readmeFromHookJson = (wants) => void writeHookConfig(ctx, opts.configDir, { url: opts.url, token, attributionReadme: wants });
  } else {
    const confPath = ensureCurlConf(ctx, opts.configDir, token, opts.url);
    removeLegacyHookEnv(ctx, opts.configDir);
    const scriptPath = ensureHookScript(ctx, opts.configDir);
    spec = { kind: 'sh', scriptPath, confPath, isDefaultConfigDir: opts.isDefaultConfigDir };
  }
  ensureServerUrlFile(ctx, opts.configDir, opts.url);

  ctx.log('\n[attribution]');
  if (opts.hook === 'sh') ensureAttributionConf(ctx, opts.configDir, token, opts.url);
  const wantsReadme = typeof opts.attribution === 'function' ? await opts.attribution() : opts.attribution;
  if (wantsReadme) {
    installAttributionReadme(ctx, opts.configDir);
  } else {
    removeAttributionReadme(ctx, opts.configDir);
    ctx.log('  README writes disabled (opt in with --attribution yes, or answer "y" at the prompt)');
  }
  // hook.json carries the attribution flag, so it is written once the answer is known.
  readmeFromHookJson(wantsReadme);

  ctx.log('\n[runner]');
  const runnerConfig = ensureRunnerConfig(opts.configDir, opts.url, opts.urlExplicit, opts.allowDirs, ctx.dryRun, opts.configDirExplicit, ctx);
  warnBroadAllowDirs(runnerConfig.allowedProjectDirs, ctx.warn);
  if (opts.envFile) ensureRunnerTokenEnv(ctx, opts.envFile, runnerConfig.token, runnerConfig.allowedProjectDirs);

  ctx.log('\n[settings.json]');
  const { added, skipped, backup } = installClaudeHooks(ctx, settingsPath, spec);
  ctx.log(`  hooks: ${added} added, ${skipped} already present`);

  if (!opts.noAgents) {
    ctx.log('\n[agents]');
    installAgents(ctx, opts.claudeDir);
  } else {
    ctx.log('\n[agents] skipped (--no-agents)');
  }

  if (!opts.noSkills) {
    ctx.log('\n[skills]');
    installSkills(ctx, opts.claudeDir);
  } else {
    ctx.log('\n[skills] skipped (--no-skills)');
  }

  ctx.log('\ntagconn installed.');
  ctx.log(`  server url: ${opts.url}`);
  ctx.log(`  config dir: ${opts.configDir}`);
  ctx.log(`  hook script: ${spec.scriptPath}`);
  ctx.log(`  settings: ${settingsPath}`);
  return { changed: [...ctx.changed], backup };
}

/** Removes only what tagconn wrote (settings.json entries of either hook kind, managed agents/skills, its config files). */
export async function uninstall(opts: UninstallOptions, ctxIn?: SetupContext): Promise<InstallResult> {
  const ctx = ctxIn ?? createContext();
  const settingsPath = join(opts.claudeDir, 'settings.json');

  ctx.log('\n[settings.json]');
  const { removed, backup } = uninstallClaudeHooks(ctx, settingsPath);
  ctx.log(`  removed ${removed} tagconn hook entr${removed === 1 ? 'y' : 'ies'}`);

  if (!opts.noAgents) {
    ctx.log('\n[agents]');
    uninstallAgents(ctx, opts.claudeDir);
  }
  if (!opts.noSkills) {
    ctx.log('\n[skills]');
    uninstallSkills(ctx, opts.claudeDir);
  }

  ctx.log('\n[hook config]');
  removeCurlConf(ctx, opts.configDir);
  removeHookConfig(ctx, opts.configDir);
  removeLegacyHookEnv(ctx, opts.configDir);
  removeServerUrlFile(ctx, opts.configDir);

  ctx.log('\n[attribution]');
  removeAttributionReadme(ctx, opts.configDir);
  removeAttributionConf(ctx, opts.configDir);

  ctx.log('\n[runner]');
  removeRunnerConfig(ctx, opts.configDir);

  ctx.log('\ntagconn uninstalled. The hook script and .env were left in place;');
  ctx.log(`remove ${opts.configDir} manually if you want the hook script gone too.`);
  return { changed: [...ctx.changed], backup };
}

/** Creates `dir` if needed and proves it is writable, before any install step touches the disk. */
export function assertWritableDir(dir: string): void {
  const probe = join(dir, `.tagconn-write-test-${process.pid}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
  } catch (err) {
    throw new Error(`Can't write to ${dir} (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). Fix its permissions or choose another folder, then run the install again. Nothing was changed.`);
  }
}

