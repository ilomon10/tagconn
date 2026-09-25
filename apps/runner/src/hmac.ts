// Mutual HMAC handshake primitives (docs/design/runner-and-helpdesk.md §2.2, packages/shared/src/auth.ts).
// The raw runner token is NEVER sent; only HMAC-SHA256 proofs over `proofMessage(...)` travel the wire.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type HmacContext, HMAC_CONTEXTS, proofMessage } from '@tagconn/shared';

/** 32 random bytes, base64url, no padding (matches auth.ts NONCE_RE / PROOF_RE). */
export function randomNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function hmacProof(token: string, context: HmacContext, role: 'server' | 'runner' | 'client', ...parts: string[]): string {
  const message = proofMessage(context, role, ...parts);
  return createHmac('sha256', Buffer.from(token, 'utf8')).update(message).digest('base64url');
}

/** Constant-time comparison; false (never throws) on any length mismatch or malformed input. */
export function verifyProof(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Convenience: the proof the runner expects FROM the server (context "runner", role "server"). */
export function expectedServerProof(token: string, nr: string, ns: string): string {
  return hmacProof(token, HMAC_CONTEXTS.runner, 'server', nr, ns);
}

/** Convenience: the proof the runner sends TO the server (context "runner", role "runner"). */
export function runnerProof(token: string, ns: string, nr: string): string {
  return hmacProof(token, HMAC_CONTEXTS.runner, 'runner', ns, nr);
}
