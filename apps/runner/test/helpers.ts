// Shared test utilities. Every fixture directory is created under a fresh `mkdtemp` sandbox in the
// OS temp dir - NEVER in the repo or the cwd (see the PM note about a stray symlink from an earlier
// concurrent run: tests must not leave artifacts outside their own sandbox).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Spawn } from '../src/capabilities.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE_PATH = join(__dirname, 'fixtures', 'fake-claude.mjs');
/** Executable shell wrapper around fake-claude.mjs; use this as `claudePath` (argv[0] must be a
 *  single executable, spawn() does not split on spaces). */
export const FAKE_CLAUDE_BIN_PATH = join(__dirname, 'fixtures', 'fake-claude');

/** A fresh temp dir under the OS tmpdir, auto-registered for cleanup via afterEach in the caller. */
export function mkSandbox(prefix = 'tagconn-runner-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function rmSandbox(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** A capabilities.Spawn that runs the fake CLI via `node test/fixtures/fake-claude.mjs <args>`. */
export const fakeClaudeSpawn: Spawn = (_command, args, opts) => {
  const r = spawnSync(process.execPath, [FAKE_CLAUDE_PATH, ...args], { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
