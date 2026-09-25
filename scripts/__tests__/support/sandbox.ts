// Shared helpers for the installer/doctor integration tests: a sandboxed
// HOME under the OS tmpdir, and a runner for the scripts as child processes
// (they must work when run exactly as `pnpm office:install` runs them:
// `node scripts/<file>.ts`).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives at <repoRoot>/scripts/__tests__/support/sandbox.ts.
export const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

export interface Sandbox {
  home: string;
  claudeDir: string;
  configDir: string;
  envFile: string;
}

/**
 * Creates a fresh temp HOME (under the OS tmpdir, never the real one) with
 * an explicit --claude-dir / --config-dir / --repo-env-file all nested
 * inside it, matching CLAUDE.md's sandboxing recipe for these scripts.
 */
export function createSandbox(prefix = 'tagconn-scripts-test-'): Sandbox {
  const home = mkdtempSync(join(tmpdir(), prefix));
  return {
    home,
    claudeDir: join(home, '.claude'),
    configDir: join(home, '.config', 'tagconn'),
    envFile: join(home, 'repo.env'),
  };
}

/** Env for a spawned script: sandboxed HOME, and no ambient tagconn/claude env leaking in. */
function sandboxEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env, HOME: home };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.TAGCONN_CONFIG_DIR;
  return env;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns `node scripts/install.ts <args>` with the sandbox's flags already applied. */
export function runInstall(sandbox: Sandbox, extraArgs: string[] = []): RunResult {
  const args = [
    join(repoRoot, 'scripts', 'install.ts'),
    '--claude-dir',
    sandbox.claudeDir,
    '--config-dir',
    sandbox.configDir,
    '--repo-env-file',
    sandbox.envFile,
    ...extraArgs,
  ];
  const res = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: sandboxEnv(sandbox.home),
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Spawns `node scripts/doctor.ts <args>` with the sandbox's flags already applied. */
export function runDoctor(sandbox: Sandbox, extraArgs: string[] = []): RunResult {
  const args = [
    join(repoRoot, 'scripts', 'doctor.ts'),
    '--claude-dir',
    sandbox.claudeDir,
    '--config-dir',
    sandbox.configDir,
    ...extraArgs,
  ];
  const res = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: sandboxEnv(sandbox.home),
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

export interface FileSnapshot {
  path: string;
  mtimeMs: number;
  size: number;
  mode: number;
  isDir: boolean;
}

/** Recursively lists `root`'s contents (empty array if it doesn't exist), sorted for stable comparison. */
export function listRecursive(root: string): FileSnapshot[] {
  const out: FileSnapshot[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const full = join(dir, name);
      const s = statSync(full);
      out.push({
        path: full,
        mtimeMs: s.mtimeMs,
        size: s.size,
        mode: s.mode & 0o777,
        isDir: s.isDirectory(),
      });
      if (s.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
