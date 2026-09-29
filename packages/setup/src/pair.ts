import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifySecretFile, type SecretOptions } from './secrets.ts';
import { isValidRunnerToken } from './validate.ts';

// The HMAC pairing flow of `pnpm office:pair` (see docs/design/runner-and-helpdesk.md §5.2 for the two-step
// protocol, packages/shared/src/auth.ts for the canonical browser/server copy of the constants below).

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

/**
 * Reads the runner token out of <configDir>/runner.json (written by scripts/install.ts).
 * Mirrors the runner's own load checks (mode 0600, token shape) - see
 * RunnerLocalConfigSchema in packages/shared/src/runner.ts - so a misconfigured or
 * tampered-with file is caught here rather than silently HMAC-ing with garbage.
 */
export function readRunnerToken(configDir: string, opts: SecretOptions = {}): string {
  const path = join(configDir, 'runner.json');
  if (!existsSync(path)) {
    throw new Error(`${path} not found. Run \`pnpm office:install --allow-dir <path>\` first.`);
  }
  const check = verifySecretFile(path, opts);
  if (!check.ok) {
    if (check.kind === 'mode') {
      throw new Error(`${path} has mode ${check.mode}, expected 600. Run: chmod 600 ${path}`);
    }
    throw new Error(`${path} is accessible by other users (${check.detail}). ${check.hint}`);
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

/** A next step for failures a user can fix themselves (the server's runner token is set from `.env`). */
export function pairFailureHint(message: string): string | undefined {
  if (!/runner\.token is not configured/.test(message)) return undefined;
  return [
    'The server has no runner token yet. Run `pnpm office:install` (it writes OFFICE_RUNNER__TOKEN to .env),',
    'then recreate the server with `pnpm office:up` (`docker compose restart` keeps the old environment).',
    'Or pair with the code printed in the server log: `docker compose logs server | grep "pairing code"`.',
  ].join('\n');
}
