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
//
// NOTE on --label: this script only mints a pairing code (POST /api/auth/pairing-codes), which
// per its contract (PairingCodeRequestSchema in packages/shared/src/auth.ts) takes no label - it
// is a strictObject of {challengeId, proof} and rejects unknown keys. The label is attached later,
// when the code is REDEEMED for a session (POST /api/auth/pair {code, label}), which happens in the
// browser when the user opens the printed URL. So --label here is accepted for convenience but is
// never sent to the server; main() prints a reminder to enter it in the browser instead.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isValidRunnerToken, validateUrl } from './install.ts';

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
    url: validateUrl(process.env.OFFICE_URL || 'http://127.0.0.1:4317'),
    webUrl: validateUrl(process.env.OFFICE_WEB_URL || 'http://localhost:4318'),
    label: undefined,
    noSquatterCheck: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config-dir') args.configDir = resolve(argv[++i] ?? '');
    else if (a === '--url') args.url = validateUrl(argv[++i] ?? args.url);
    else if (a === '--web-url') args.webUrl = validateUrl(argv[++i] ?? args.webUrl);
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
  --label <text>         Accepted for convenience but NOT sent when minting the code (the
                         pairing-codes endpoint takes no label); enter it in the browser's
                         pairing form when you redeem the code instead.
  --no-squatter-check    Skip comparing the web origin's instanceId to the server's.
  --help                 Show this help.
`);
}

/**
 * Reads the runner token out of <configDir>/runner.json (written by scripts/install.ts).
 * Mirrors the runner's own load checks (mode 0600, token shape) - see
 * RunnerLocalConfigSchema in packages/shared/src/runner.ts - so a misconfigured or
 * tampered-with file is caught here rather than silently HMAC-ing with garbage.
 */
export function readRunnerToken(configDir: string): string {
  const path = join(configDir, 'runner.json');
  if (!existsSync(path)) {
    throw new Error(`${path} not found. Run \`pnpm office:install --allow-dir <path>\` first.`);
  }
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`${path} has mode ${mode.toString(8)}, expected 600. Run: chmod 600 ${path}`);
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
  if (!isValidRunnerToken(token)) {
    throw new Error(`${path}'s token is not a valid runner token (expected 32-128 lowercase hex chars).`);
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

async function postJson<T>(url: string, body: unknown, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`${url} did not respond within ${timeoutMs}ms: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
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
  /**
   * Undefined = skipped (--no-squatter-check) or inconclusive (a health endpoint was
   * unreachable). true/false = the web origin (SC4 M3: instanceId AND version AND the
   * pairing URL's origin) matched what the HMAC-verified server told us.
   */
  squatterCheckPassed?: boolean;
}

/**
 * Runs the full two-step HMAC pairing handshake (§5.2) against `baseUrl`, using `token` as the HMAC
 * key. Throws on a bad/missing/late proof (the server proof check happens locally, before any
 * further request - a wrong URL or an impersonator is refused, not silently trusted).
 *
 * The squatter check (T9, residual risk in §5.2) runs AFTER minting the code, because it needs the
 * code response's own `url` to check its origin. It never weakens the proof check above - that one
 * already refuses to continue on any mismatch. This one is reported back for the caller (main()) to
 * act on: SC4 M3 requires refusing to print/reveal the code on a mismatch, fail-closed, unless the
 * caller explicitly opted out with `skipSquatterCheck`.
 *
 * Takes no `label`: PairingCodeRequestSchema (packages/shared/src/auth.ts) is a strictObject of
 * {challengeId, proof} and rejects unknown keys. A label is attached later, when the code is
 * redeemed (POST /api/auth/pair {code, label}) - see main()'s note for --label.
 */
export async function mintPairingCode(
  baseUrl: string,
  webUrl: string,
  token: string,
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

  const clientProof = hmac(token, proofMessage('client', challenge.nonce, nc));
  const code = await postJson<PairingCodeResponse>(`${base}/api/auth/pairing-codes`, {
    challengeId: challenge.challengeId,
    proof: clientProof,
  });

  let squatterCheckPassed: boolean | undefined;
  if (!skipSquatterCheck) {
    // Free, local check: does the URL the server handed us even point at the web origin
    // the caller asked about? A server that redirects the printed link elsewhere is
    // exactly the T9 scenario this check exists for.
    let originMatches: boolean;
    try {
      originMatches = new URL(code.url).origin === new URL(webUrl).origin;
    } catch {
      originMatches = false;
    }

    const directHealth = await getJson<HealthBody>(`${base}/api/health`);
    const webHealth = await getJson<HealthBody>(`${webUrl.replace(/\/+$/, '')}/api/health`);
    if (directHealth?.instanceId && webHealth?.instanceId) {
      squatterCheckPassed =
        originMatches &&
        webHealth.instanceId === directHealth.instanceId &&
        webHealth.instanceId === challenge.instanceId &&
        webHealth.version === directHealth.version;
    } else {
      // Health endpoints inconclusive (unreachable): still enforce the free origin check -
      // a mismatch there is decisive on its own and needs no network round trip to trust.
      squatterCheckPassed = originMatches ? undefined : false;
    }
  }

  return { ...code, squatterCheckPassed };
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.label) {
    // See the header comment: --label is not sent to /api/auth/pairing-codes (it takes no
    // label). It is entered in the browser's pairing form instead, when the code is redeemed.
    console.log(`Note: --label is not sent when minting a code; enter "${args.label}" in the browser's pairing form.`);
  }

  const token = readRunnerToken(args.configDir);
  const result = await mintPairingCode(args.url, args.webUrl, token, args.noSquatterCheck);

  if (result.squatterCheckPassed === false) {
    // SC4 M3: fail closed - never print the code/URL when the web origin doesn't check out.
    // The code the server minted is now spent (single use), but that's a smaller cost than
    // handing the user a link that might not be their own server.
    console.error(
      `REFUSING to print the pairing code: ${args.webUrl} does not look like the same server as ${args.url} ` +
        '(instanceId/version mismatch, or the pairing URL points at a different origin). Something else may be ' +
        'answering on the web port. Re-run with --no-squatter-check to override if you are certain this is safe. ' +
        '(See docs/design/runner-and-helpdesk.md §5.2, T9.)',
    );
    process.exitCode = 1;
    return;
  }
  if (result.squatterCheckPassed === undefined && !args.noSquatterCheck) {
    console.warn(`Could not fully verify ${args.webUrl} matches the server (a health endpoint was unreachable).`);
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
