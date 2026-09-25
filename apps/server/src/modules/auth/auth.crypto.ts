import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ADMIN_TOKEN_PREFIX, PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, type HmacContext, proofMessage } from '@tagconn/shared';

/** Constant-time string compare (only meaningful for equal-length secrets; unequal lengths are just "not equal"). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** sha256 hex digest, used to store admin session tokens (never the raw token). */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `tca_` + 32 random bytes, base64url (43 chars, matches ADMIN_TOKEN_RE). */
export function generateAdminToken(): string {
  return `${ADMIN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** 43-char base64url nonce/proof (matches NONCE_RE / PROOF_RE). */
export function generateNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** HMAC-SHA256 over `proofMessage(...)`, keyed with the UTF-8 bytes of `token`, base64url output. */
export function hmacProof(token: string, context: HmacContext, role: 'server' | 'runner' | 'client', ...parts: string[]): string {
  return createHmac('sha256', Buffer.from(token, 'utf8')).update(proofMessage(context, role, ...parts)).digest('base64url');
}

/** `timingSafeEqual` against a freshly computed proof for the same inputs. */
export function verifyProof(token: string, context: HmacContext, role: 'server' | 'runner' | 'client', proof: string, ...parts: string[]): boolean {
  return safeEqual(hmacProof(token, context, role, ...parts), proof);
}

/**
 * 12 Crockford base32 characters (60 bits): 12 random bytes, 5 bits each via a bitmask (the alphabet
 * is exactly 32 = 2^5 entries, so `& 0x1f` has no modulo bias). Returned ungrouped (no `-`); callers
 * format for display with `formatPairingCode`.
 */
export function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    // biome-ignore lint: bytes[i] is always defined (fixed-length buffer of PAIRING_CODE_LENGTH)
    code += PAIRING_CODE_ALPHABET[bytes[i]! & 0x1f];
  }
  return code;
}

/** "ABCDEFGHJKMN" -> "ABCD-EFGH-JKMN" for display. */
export function formatPairingCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}
