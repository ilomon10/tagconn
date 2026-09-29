// Shared harness for the packages/hook tests (functional in hook-attribution.test.ts,
// timing/perf-budget in hook-attribution.perf.test.ts). Two hooks, one harness:
//   - 'sh'   office-hook.sh with a fake `curl` on PATH (nothing touches the network)
//   - 'node' office-hook.mjs with hook.json pointed at a local HTTP test server
// Both write request logs into the same format (`ARG: <header>` lines, then the body between
// `--- stdin ---` and `--- end ---`) so one set of assertions covers both. Every run also
// asserts that the hook printed NOTHING on stdout. HOME/CLAUDE_PROJECT_DIR are sandboxed
// (never the real ones - see support/real-paths-guard.ts).
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { repoRoot } from './sandbox.ts';

export type HookKind = 'sh' | 'node';
export const HOOK_KINDS: HookKind[] = ['sh', 'node'];

export const hookScript = join(repoRoot, 'packages', 'hook', 'office-hook.sh');
export const nodeHookScript = join(repoRoot, 'packages', 'hook', 'office-hook.mjs');

export type ServerMode = 'ok' | 'error500' | 'hang';

export interface HookServer {
  url: string;
  mode: ServerMode;
  requests: { url: string; headers: Record<string, string | string[] | undefined>; body: string }[];
  close(): Promise<void>;
}

/** A local stand-in for the office server; appends every request to `logFile` in the fake-curl format. */
export async function startHookServer(logFile: string, mode: ServerMode = 'ok'): Promise<HookServer> {
  const requests: HookServer['requests'] = [];
  const state = { mode };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ url: req.url ?? '', headers: req.headers, body });
      const headerLines = Object.entries(req.headers).map(([k, v]) => `ARG: ${k}: ${String(v)}`);
      appendFileSync(
        logFile,
        ['=== invocation ===', `ARG: ${req.url}`, ...headerLines, '--- stdin ---', body, '--- end ---', ''].join('\n'),
      );
      if (state.mode === 'hang') return; // never answer
      res.statusCode = state.mode === 'error500' ? 500 : 200;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get mode() {
      return state.mode;
    },
    set mode(m: ServerMode) {
      state.mode = m;
    },
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  } as HookServer;
}

/**
 * Creates a fake `curl` that never touches the network: it appends its argv and
 * stdin to $FAKE_CURL_LOG, then exits 0 (mirroring a real successful POST).
 * Returns the bin dir to prepend to PATH.
 */
export function makeFakeCurlBin(): string {
  const binDir = mkdtempSync(join(tmpdir(), 'tagconn-fake-bin-'));
  const fakeCurl = [
    '#!/bin/sh',
    'log="${FAKE_CURL_LOG:?FAKE_CURL_LOG not set}"',
    '{',
    '  echo "=== invocation ==="',
    '  for a in "$@"; do echo "ARG: $a"; done',
    '  echo "--- stdin ---"',
    '  cat',
    '  echo "--- end ---"',
    '} >> "$log"',
    'exit 0',
    '',
  ].join('\n');
  writeFileSync(join(binDir, 'curl'), fakeCurl, { mode: 0o755 });
  return binDir;
}

export interface HookSandbox {
  kind: HookKind;
  home: string;
  configDir: string;
  curlConf: string;
  hookJson: string;
  projectDir: string;
  logFile: string;
  server?: HookServer;
}

/** Writes (or rewrites) the node hook's hook.json; `patch` overrides fields. */
export function writeHookJson(sandbox: HookSandbox, patch: Record<string, unknown> = {}): void {
  const cfg = {
    version: 1,
    url: sandbox.server?.url ?? 'http://127.0.0.1:1',
    token: 'testtoken',
    attributionReadme: false,
    ...patch,
  };
  writeFileSync(sandbox.hookJson, JSON.stringify(cfg), { mode: 0o600 });
}

/** Creates a sandbox for one hook kind (starts the local test server for 'node'). Call sandbox.server?.close() when done. */
export async function createHookSandbox(kind: HookKind = 'sh', serverMode: ServerMode = 'ok'): Promise<HookSandbox> {
  const root = mkdtempSync(join(tmpdir(), 'tagconn-hook-test-'));
  const home = join(root, 'home');
  const configDir = join(root, 'config');
  const projectDir = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const curlConf = join(configDir, 'curl.conf');
  writeFileSync(curlConf, 'header = "x-office-token: testtoken"\nurl = "http://127.0.0.1:4317/api/hooks"\n', {
    mode: 0o600,
  });
  const sandbox: HookSandbox = {
    kind,
    home,
    configDir,
    curlConf,
    hookJson: join(configDir, 'hook.json'),
    projectDir,
    logFile: join(root, 'fake-curl.log'),
  };
  if (kind === 'node') {
    sandbox.server = await startHookServer(sandbox.logFile, serverMode);
    writeHookJson(sandbox);
  }
  return sandbox;
}

/**
 * Opts the sandbox in to README writes: writes the template, and for the node hook sets
 * attributionReadme (the sh hook's only switch is the template existing).
 */
export function enableReadme(sandbox: HookSandbox, template: string): void {
  writeFileSync(join(sandbox.configDir, 'attribution-README.md'), template);
  if (sandbox.kind === 'node') writeHookJson(sandbox, { attributionReadme: true });
}

export interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/** Runs the hook with `input` (a string, or a value that is JSON-stringified) on stdin, asserting stdout stays empty. */
export async function runHook(
  binDir: string,
  sandbox: HookSandbox,
  body: unknown,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<HookResult> {
  const env: NodeJS.ProcessEnv =
    sandbox.kind === 'sh'
      ? {
          PATH: `${binDir}:${process.env.PATH}`,
          HOME: sandbox.home,
          TAGCONN_CURL_CONF: sandbox.curlConf,
          FAKE_CURL_LOG: sandbox.logFile,
          CLAUDE_PROJECT_DIR: sandbox.projectDir,
          ...extraEnv,
        }
      : {
          PATH: process.env.PATH,
          HOME: sandbox.home,
          USERPROFILE: sandbox.home,
          TAGCONN_HOOK_CONFIG: sandbox.hookJson,
          CLAUDE_PROJECT_DIR: sandbox.projectDir,
          ...extraEnv,
        };
  const res = await spawnHook(sandbox.kind, typeof body === 'string' ? body : JSON.stringify(body), env);
  expect(res.stdout).toBe('');
  return res;
}

/** Spawns the hook with an exact env and stdin string (no stdout assertion; used by runHook and edge-case tests). */
export function spawnHook(kind: HookKind, input: string, env: NodeJS.ProcessEnv): Promise<HookResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child =
      kind === 'sh' ? spawn('sh', [hookScript], { env }) : spawn(process.execPath, [nodeHookScript], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.on('error', () => {});
    child.on('close', (status) => resolve({ status, stdout, stderr, elapsedMs: Date.now() - start }));
    child.stdin.end(input);
  });
}
