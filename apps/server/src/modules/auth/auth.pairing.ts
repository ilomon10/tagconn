import { PAIRING_CHALLENGE_TTL_MS } from '@tagconn/shared';

const MAX_LIVE_CODES = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

interface Challenge {
  nonceClient: string;
  nonceServer: string;
  createdAt: number;
}

interface Code {
  expiresAt: number;
  createdAt: number;
}

/**
 * Per-app-instance, in-memory pairing state (docs/design/runner-and-helpdesk.md §5.2): challenges and
 * codes are ephemeral by design (tied to the current server boot's `instanceId`), so they live only in
 * memory, not the DB. One instance per `AuthService` (never a module-level singleton), so separate
 * `buildApp()` calls in the same test process never share rate limits or codes.
 */
export class PairingStore {
  private challenges = new Map<string, Challenge>();
  private codes = new Map<string, Code>();
  private attempts: number[] = [];

  private prune(now: number): void {
    for (const [id, c] of this.challenges) if (now - c.createdAt > PAIRING_CHALLENGE_TTL_MS) this.challenges.delete(id);
    for (const [code, c] of this.codes) if (now > c.expiresAt) this.codes.delete(code);
    this.attempts = this.attempts.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  }

  /** Global limit shared by code redemption and challenge/code minting (§5.2: "10 per minute", no per-code lockout). */
  recordAttempt(now = Date.now()): boolean {
    this.prune(now);
    if (this.attempts.length >= RATE_LIMIT_MAX) return false;
    this.attempts.push(now);
    return true;
  }

  addChallenge(id: string, nonceClient: string, nonceServer: string, now = Date.now()): void {
    this.prune(now);
    this.challenges.set(id, { nonceClient, nonceServer, createdAt: now });
  }

  /** Single use: a replayed challengeId always fails, whether the first use succeeded or not. */
  takeChallenge(id: string, now = Date.now()): Challenge | undefined {
    this.prune(now);
    const c = this.challenges.get(id);
    if (!c) return undefined;
    this.challenges.delete(id);
    return now - c.createdAt > PAIRING_CHALLENGE_TTL_MS ? undefined : c;
  }

  /** At most 3 live codes (§5.2): evicts the oldest before adding a new one past the cap. */
  addCode(code: string, ttlMs: number, now = Date.now()): void {
    this.prune(now);
    if (this.codes.size >= MAX_LIVE_CODES) {
      let oldestCode: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [k, v] of this.codes) {
        if (v.createdAt < oldestAt) {
          oldestAt = v.createdAt;
          oldestCode = k;
        }
      }
      if (oldestCode !== undefined) this.codes.delete(oldestCode);
    }
    this.codes.set(code, { expiresAt: now + ttlMs, createdAt: now });
  }

  /** Single use: a matched code is deleted immediately regardless of expiry, so replay always fails. */
  takeCode(code: string, now = Date.now()): boolean {
    this.prune(now);
    const c = this.codes.get(code);
    if (!c) return false;
    this.codes.delete(code);
    return now <= c.expiresAt;
  }
}
