#!/usr/bin/env node
// tagconn pairing CLI (`pnpm office:pair`): mints a browser pairing code by proving
// possession of the runner token over HMAC-SHA256 - the raw token is never sent on
// the wire. See docs/design/runner-and-helpdesk.md §5.2 for the two-step protocol
// this mirrors, and packages/shared/src/auth.ts for the canonical (browser/server)
// copy of the constants duplicated below.
//
// Node 24 runs this directly (type stripping) — erasable TS syntax only,
// node: builtins only, no npm dependencies (this is why the constants below are
// copied rather than imported - see scripts/install.ts's header comment).
//
// Usage:
//   node scripts/pair.ts [--config-dir <path>] [--url <server url>] [--web-url <web url>]
//                         [--label <text>] [--no-squatter-check]

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Mirrors packages/shared/src/auth.ts NONCE_RE/PROOF_RE: 32 random bytes, base64url, no padding.
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const PROOF_RE = NONCE_RE;
// Mirrors HMAC_CONTEXTS.pairing.
const PAIRING_CONTEXT = 'tagconn-pair-v1';

/** Mirrors packages/shared/src/auth.ts proofMessage: `<context>|<role>|<part1>|<part2>...`. */
function proofMessage(role: 'server' | 'client', ...parts: string[]): string {
  return [PAIRING_CONTEXT, role, ...parts].join('|');
}

/** HMAC-SHA256 keyed with the token's UTF-8 bytes, base64url output (no padding). */
function hmac(token: string, message: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8')).update(message).digest('base64url');
}

function proofsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'tagconn');

export interface Args {
  configDir: string;
  url: string;
  webUrl: string;
  label?: string;
  noSquatterCheck: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = {
    configDir: process.env.TAGCONN_CONFIG_DIR ? resolve(process.env.TAGCONN_CONFIG_DIR) : DEFAULT_CONFIG_DIR,
    url: process.env.OFFICE_URL || 'http://127.0.0.1:4317',
    webUrl: process.env.OFFICE_WEB_URL || 'http://localhost:4318',
    label: undefined,
    noSquatterCheck: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config-dir') args.configDir = resolve(argv[++i] ?? '');
    else if (a === '--url') args.url = argv[++i] ?? args.url;
    else if (a === '--web-url') args.webUrl = argv[++i] ?? args.webUrl;
    else if (a === '--label') args.label = argv[++i];
    else if (a === '--no-squatter-check') args.noSquatterCheck = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      args.help = true;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`tagconn pair - mint a browser pairing code

Usage:
  node scripts/pair.ts [options]

Options:
  --config-dir <path>    Dir holding runner.json (default: $TAGCONN_CONFIG_DIR or ~/.config/tagconn).
  --url <server url>     Office server URL (default: http://127.0.0.1:4317).
  --web-url <web url>    Browser-facing origin, for the :4318 squatter check
                         (default: http://localhost:4318).
  --label <text>         Label shown in the session list (e.g. "Firefox on laptop").
  --no-squatter-check    Skip comparing the web origin's instanceId to the server's.
  --help                 Show this help.
`);
}

/** Reads the runner token out of <configDir>/runner.json (written by scripts/install.ts). */
export function readRunnerToken(configDir: string): string {
  const path = join(configDir, 'runner.json');
  if (!existsSync(path)) {
    throw new Error(`${path} not found. Run \`pnpm office:install --allow-dir <path>\` first.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const token = (parsed as { token?: unknown } | null)?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`${path} has no runner token.`);
  }
  return token;
}

interface PairingChallengeResponse {
  challengeId: string;
  nonce: string;
  instanceId: string;
  proof: string;
}

interface PairingCodeResponse {
  code: string;
  url: string;
  expiresAt: number;
}

interface HealthBody {
  instanceId?: string;
  version?: string;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`${url} did not return valid JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const message = (parsed as { error?: string } | undefined)?.error ?? `HTTP ${res.status}`;
    throw new Error(`${url} failed: ${message}`);
  }
  return parsed as T;
}

async function getJson<T>(url: string, timeoutMs = 1500): Promise<T | undefined> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

export interface PairResult {
  code: string;
  url: string;
  expiresAt: number;
  /** Undefined = skipped or inconclusive; true/false = the web origin's instanceId did/didn't match. */
  squatterCheckPassed?: boolean;
}

/**
 * Runs the full two-step HMAC pairing handshake (§5.2) against `baseUrl`, using `token` as the HMAC
 * key. Throws on a bad/missing/late proof (the server proof check happens locally, before any
 * further request - a wrong URL or an impersonator is refused, not silently trusted).
 */
export async function mintPairingCode(
  baseUrl: string,
  webUrl: string,
  token: string,
  label: string | undefined,
  skipSquatterCheck: boolean,
): Promise<PairResult> {
  const base = baseUrl.replace(/\/+$/, '');
  const nc = randomBytes(32).toString('base64url');

  const challenge = await postJson<PairingChallengeResponse>(`${base}/api/auth/pairing-challenge`, { nonce: nc });
  if (!NONCE_RE.test(challenge.nonce) || !PROOF_RE.test(challenge.proof)) {
    throw new Error('server response malformed (nonce/proof shape)');
  }
  const expectedServerProof = hmac(token, proofMessage('server', nc, challenge.nonce, challenge.instanceId));
  if (!proofsEqual(expectedServerProof, challenge.proof)) {
    throw new Error(
      'server proof invalid: wrong URL, wrong runner token, or an impersonator. Refusing to continue.',
    );
  }

  let squatterCheckPassed: boolean | undefined;
  if (!skipSquatterCheck) {
    const webHealth = await getJson<HealthBody>(`${webUrl.replace(/\/+$/, '')}/api/health`);
    if (webHealth?.instanceId) {
      squatterCheckPassed = webHealth.instanceId === challenge.instanceId;
    }
  }

  const clientProof = hmac(token, proofMessage('client', challenge.nonce, nc));
  const code = await postJson<PairingCodeResponse>(`${base}/api/auth/pairing-codes`, {
    challengeId: challenge.challengeId,
    proof: clientProof,
    ...(label ? { label } : {}),
  });

  return { ...code, squatterCheckPassed };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const token = readRunnerToken(args.configDir);
  const result = await mintPairingCode(args.url, args.webUrl, token, args.label, args.noSquatterCheck);

  if (result.squatterCheckPassed === false) {
    console.warn(
      `WARNING: ${args.webUrl} reports a different instanceId than the server at ${args.url}. ` +
        'Something else may be answering on the web port - do not open the link below until this is resolved. ' +
        '(See docs/design/runner-and-helpdesk.md §5.2, T9.)',
    );
  } else if (result.squatterCheckPassed === undefined && !args.noSquatterCheck) {
    console.warn(`Could not verify ${args.webUrl} matches the server (unreachable) - skipping the squatter check.`);
  }

  console.log(`Pairing code: ${result.code}`);
  console.log(`Open: ${result.url}`);
  const expiresInSec = Math.max(0, Math.round((result.expiresAt - Date.now()) / 1000));
  console.log(`Expires in ${expiresInSec}s.`);
}

// Only run when this file is the entry point (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err: unknown) => {
    console.error(`tagconn pair failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
