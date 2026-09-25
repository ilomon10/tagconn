import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The HMAC half of `docs/design/runner-and-helpdesk.md` §2.2 / `packages/shared/src/auth.ts`'s
 * `proofMessage`. The raw `settings.runner.token` is the HMAC key; it is NEVER sent on the wire,
 * only proofs of possession (base64url HMAC-SHA256 over a `proofMessage(...)` string).
 */

/** 32 random bytes, base64url, no padding (matches `NONCE_RE`). */
export function freshNonce(): string {
  return randomBytes(32).toString('base64url');
}

export function computeProof(token: string, message: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8')).update(message, 'utf8').digest('base64url');
}

/** Constant-time compare; `false` (never throws) on a length mismatch. */
export function verifyProof(token: string, message: string, proof: string): boolean {
  const expected = Buffer.from(computeProof(token, message));
  const got = Buffer.from(proof);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
