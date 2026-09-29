#!/usr/bin/env node
// tagconn doctor: sanity-checks the local install (hook, curl.conf, Claude Code
// settings, server reachability, docker compose, the M8 runner + pairing).
// Prints one line per check and exits 1 if any hard check fails.
//
// Node 24 runs this directly (type stripping) - erasable TS syntax only,
// node: builtins only, no npm dependencies. The checks live in packages/setup (imported by RELATIVE
// path, because node refuses to strip types under node_modules); this file is the CLI and the reporter.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createDoctorEnv,
  resolveConfigDir as libResolveConfigDir,
  resolveSetupPaths,
  runDoctor,
  validateUrl,
  type DoctorReporter,
  type ResolveConfigDirInputs,
} from '../packages/setup/src/index.ts';

// Re-exported for the tests and for anyone who imported them from here before.
export { extractHookScriptPath, isOurCommand } from '../packages/setup/src/index.ts';
export type { HealthProbe } from '../packages/setup/src/index.ts';
export type { ResolveConfigDirInputs };

export interface Args {
  claudeDir: string;
  configDir: string;
  url: string;
  /** The browser-facing origin (nginx/Vite dev), used for the :4318 squatter check. */
  webUrl: string;
  help: boolean;
}

const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude');
// POSIX keeps ~/.config/tagconn (where office-hook.sh looks); win32 uses %APPDATA%\tagconn.
const DEFAULT_CONFIG_DIR = resolveSetupPaths({ legacyPosixConfig: true }).config;

/**
 * Resolves the config dir. Same as scripts/install.ts's resolveConfigDir:
 * --config-dir flag > TAGCONN_CONFIG_DIR env > derived from a non-default
 * claude dir > the OS default (~/.config/tagconn on POSIX).
 */
export function resolveConfigDir(inputs: ResolveConfigDirInputs): string {
  return libResolveConfigDir(inputs, { legacyPosixConfig: true });
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

/** Console output: one coloured line per check, and a count of the hard failures. */
const consoleReporter: DoctorReporter = {
  ok(label) {
    console.log(`\x1b[32m✔\x1b[0m ${label}`);
  },
  fail(label, hint, hard = true) {
    console.log(`\x1b[31m✖\x1b[0m ${label}`);
    console.log(`    ${hint}`);
    if (hard) hardFailures++;
  },
  warn(label, hint) {
    console.log(`\x1b[33m○\x1b[0m ${label}`);
    console.log(`    ${hint}`);
  },
  na(label, note) {
    console.log(`\x1b[2m-\x1b[0m ${label}`);
    console.log(`    ${note}`);
  },
  line(text) {
    console.log(text);
  },
};

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/doctor.ts [--claude-dir <path>] [--config-dir <path>] [--url <server url>] [--web-url <web url>]',
    );
    return;
  }

  await runDoctor(
    { claudeDir: args.claudeDir, configDir: args.configDir, url: args.url, webUrl: args.webUrl },
    createDoctorEnv(consoleReporter, { repoRoot: resolve(import.meta.dirname, '..') }),
  );

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
