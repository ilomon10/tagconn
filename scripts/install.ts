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
//                            [--hook sh|node] [--node-path <exe>]
//   node scripts/install.ts --uninstall [...same flags]

// The logic lives in packages/setup (shared with the desktop supervisor); this file is the CLI: flags in,
// output out. It imports the library by RELATIVE path because node refuses to strip types under
// node_modules, so `node scripts/install.ts` could not load it through a workspace link.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createContext,
  install,
  installHooks as installHooksSpec,
  promptAttribution,
  resolveConfigDir as libResolveConfigDir,
  resolveSetupPaths,
  uninstall,
  validateNoSingleQuote,
  validateUrl,
  type HookKind,
  type ResolveConfigDirInputs,
  type SettingsJson,
} from '../packages/setup/src/index.ts';

// Re-exported: scripts/__tests__ and doctor.ts/pair.ts import these from here.
export {
  buildAgentFile,
  countGitReposBelow,
  ensureRunnerConfig,
  isBroadAllowDir,
  isExplicitFalse,
  isOurCommand,
  isValidRoleName,
  isValidRunnerToken,
  isValidToken,
  ourCommand,
  parseEnvFile,
  parseFrontmatter,
  promptAttribution,
  uninstallHooks,
  upsertEnvLine,
  validateNoSingleQuote,
  validateUrl,
  warnBroadAllowDirs,
} from '../packages/setup/src/index.ts';
export type { HookEntry, MatcherGroup, SettingsJson } from '../packages/setup/src/index.ts';
export type { ResolveConfigDirInputs };

/** The sh-hook merge with its original signature (kept for scripts/__tests__/hooks.test.ts). */
export function installHooks(
  settings: SettingsJson,
  hookScriptPath: string,
  confPath: string,
  isDefaultConfigDir: boolean,
): { added: number; skipped: number } {
  return installHooksSpec(settings, { kind: 'sh', scriptPath: hookScriptPath, confPath, isDefaultConfigDir });
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');

export interface Args {
  uninstall: boolean;
  dryRun: boolean;
  claudeDir: string;
  configDir: string;
  url: string;
  /** L7: true only if `--url` was actually passed, so `ensureRunnerConfig` can tell "the default"
   * from "the user explicitly asked for this" when deciding whether to overwrite an existing
   * runner.json's url on a reinstall. */
  urlExplicit: boolean;
  noAgents: boolean;
  noSkills: boolean;
  project?: string;
  envFile: string;
  help: boolean;
  /** Explicit answer to the "write .tagconn/README.md" prompt; undefined = ask (or default no, non-interactively). */
  attribution?: 'yes' | 'no';
  /** `--allow-dir` may repeat; each becomes a runner.json `allowedProjectDirs` entry. */
  allowDirs: string[];
  /**
   * True when the operator explicitly asked for a non-default location - `--config-dir`,
   * `TAGCONN_CONFIG_DIR`, or a non-default `--claude-dir`/`CLAUDE_CONFIG_DIR`/`--project` (any of
   * `resolveConfigDir`'s branches other than its final default fallback). Unlike comparing the resolved
   * `configDir` to the default by value (see `isDefaultConfigDir` in main()), this stays accurate even
   * when $HOME/$CLAUDE_CONFIG_DIR are themselves overridden (e.g. a sandboxed test run) and happen to
   * derive the same path a real default install would - see `ensureRunnerConfig`'s `sandboxed` param,
   * which needs "did the operator ask for this", not "does this path happen to equal the default one".
   */
  configDirExplicit: boolean;
  /** Which hook to register: `sh` (curl, the default) or `node` (office-hook.mjs in exec form). */
  hook: HookKind;
  /** The node executable the node hook runs with (default: this process's node). */
  nodePath: string;
}

const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude');
// POSIX keeps ~/.config/tagconn (where office-hook.sh looks); win32 uses %APPDATA%\tagconn.
const DEFAULT_CONFIG_DIR = resolveSetupPaths({ legacyPosixConfig: true }).config;

/**
 * Resolves the config dir (holds curl.conf/hook.json + the installed copy of the hook script):
 * --config-dir flag > TAGCONN_CONFIG_DIR env > derived from a non-default claude dir > the OS default.
 */
export function resolveConfigDir(inputs: ResolveConfigDirInputs): string {
  return libResolveConfigDir(inputs, { legacyPosixConfig: true });
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
    urlExplicit: false,
    noAgents: false,
    noSkills: false,
    project: undefined,
    envFile: join(repoRoot, '.env'),
    help: false,
    attribution: undefined,
    allowDirs: [],
    configDirExplicit: false, // resolved below, once all flags are parsed
    hook: 'sh',
    nodePath: process.execPath,
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
        args.urlExplicit = true;
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
      case '--hook': {
        const v = argv[++i];
        if (v !== 'sh' && v !== 'node') {
          console.error(`--hook must be "sh" or "node" (got ${JSON.stringify(v)})`);
          args.help = true;
          break;
        }
        args.hook = v;
        break;
      }
      case '--node-path':
        args.nodePath = resolve(argv[++i] ?? '');
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
  const configDirEnv = process.env.TAGCONN_CONFIG_DIR;
  args.configDir = resolveConfigDir({ configDirFlag, configDirEnv, claudeDirExplicit, claudeDir: args.claudeDir });
  args.configDirExplicit =
    Boolean(configDirFlag) || Boolean(configDirEnv) || (claudeDirExplicit && resolve(args.claudeDir) !== DEFAULT_CLAUDE_DIR);
  validateNoSingleQuote(args.configDir, '--config-dir');
  return args;
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
  --hook sh|node         Which hook to register: "sh" (curl; default) or "node" (office-hook.mjs,
                          run by node in exec form; works on Windows).
  --node-path <exe>      Node executable for --hook node (default: the node running this script).
  --attribution yes|no   Write .tagconn/README.md into git repos you open (default: ask
                          interactively, or "no" when not run in a terminal).
  --allow-dir <path>     A directory quests/the Receptionist may run in (repeatable).
                          Written to runner.json's allowedProjectDirs. Broad parents
                          ($HOME, or a dir with many git repos under it) print a warning.
  --help                 Show this help.
`);
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const ctx = createContext({ dryRun: args.dryRun });
  ctx.log(`tagconn ${args.uninstall ? 'uninstall' : 'install'}`);
  ctx.log(`  claude dir: ${args.claudeDir}`);
  ctx.log(`  config dir: ${args.configDir}`);
  if (args.dryRun) ctx.log('  (dry run - no files will be written)');

  if (args.uninstall) {
    await uninstall(
      { claudeDir: args.claudeDir, configDir: args.configDir, noAgents: args.noAgents, noSkills: args.noSkills },
      ctx,
    );
    return;
  }

  await install(
    {
      claudeDir: args.claudeDir,
      configDir: args.configDir,
      url: args.url,
      urlExplicit: args.urlExplicit,
      noAgents: args.noAgents,
      noSkills: args.noSkills,
      envFile: args.envFile,
      allowDirs: args.allowDirs,
      configDirExplicit: args.configDirExplicit,
      hook: args.hook,
      nodePath: args.nodePath,
      attribution: () => promptAttribution(args.attribution, ctx.log),
      isDefaultConfigDir: args.configDir === DEFAULT_CONFIG_DIR,
    },
    ctx,
  );
  ctx.log('\nNext: start the server (pnpm office:up, or pnpm dev), then run `claude` in any project.');
  ctx.log('Run `node scripts/doctor.ts` to verify the install.');
}

// Only run when this file is the entry point (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(`tagconn install failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
