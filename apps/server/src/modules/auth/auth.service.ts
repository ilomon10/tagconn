import { randomUUID } from 'node:crypto';
import {
  ADMIN_TOKEN_RE,
  type AdminSessionInfo,
  type AuthStatus,
  type AuthTokenResponse,
  type BootstrapRequest,
  HMAC_CONTEXTS,
  type PairingChallengeResponse,
  type PairingCodeResponse,
  PAIRING_FRAGMENT_KEY,
  type PairRequest,
} from '@tagconn/shared';
import type { AdminSessionCheck, AdminVerifier } from '../../core/http/index.js';
import { HttpError, notFound } from '../../core/http/index.js';
import type { Deps } from '../../core/di/index.js';
import { INSTANCE_ID } from '../health/health.instance.js';
import type { AuthRepository } from './auth.repository.js';
import { formatPairingCode, generateAdminToken, generateNonce, generatePairingCode, hmacProof, sha256Hex, verifyProof } from './auth.crypto.js';
import { PairingStore } from './auth.pairing.js';

/** Present on `POST /api/auth/bootstrap` requests only (built by auth.routes.ts from the raw request). */
export interface BootstrapContext {
  origin?: string;
  secFetchSite?: string;
  userAgent?: string;
}

export class AuthService implements AdminVerifier {
  private readonly pairing = new PairingStore();

  constructor(private readonly deps: Deps<'authRepository' | 'settings' | 'logger' | 'adminGuard'>) {}

  private get repo(): AuthRepository {
    return this.deps.authRepository;
  }

  // ---------------------------------------------------------------- sessions

  verify(token: string | undefined): AdminSessionCheck {
    if (!token || !ADMIN_TOKEN_RE.test(token)) return { ok: false };
    const now = Date.now();
    const row = this.repo.findByHash(sha256Hex(token));
    if (!row) return { ok: false };
    if (row.expiresAt <= now) {
      this.repo.deleteById(row.id); // opportunistic cleanup
      return { ok: false };
    }
    const { sessionIdleHours, sessionMaxAgeDays } = this.deps.settings.get().auth;
    const expiresAt = Math.min(now + sessionIdleHours * 3_600_000, row.createdAt + sessionMaxAgeDays * 86_400_000);
    this.repo.touch(row.id, now, expiresAt);
    return { ok: true, sessionId: row.id, expiresAt };
  }

  status(token: string | undefined): AuthStatus {
    const { mode, protect } = this.deps.settings.get().auth;
    if (!token) return { mode, protect, admin: false };
    const check = this.verify(token);
    return check.ok ? { mode, protect, admin: true, sessionId: check.sessionId, expiresAt: check.expiresAt } : { mode, protect, admin: false };
  }

  listSessions(currentSessionId: string | undefined): AdminSessionInfo[] {
    const now = Date.now();
    return this.repo
      .listByLastUsedDesc()
      .filter((r) => r.expiresAt > now)
      .map((r) => ({
        id: r.id,
        label: r.label ?? undefined,
        userAgent: r.userAgent ?? undefined,
        createdAt: r.createdAt,
        lastUsedAt: r.lastUsedAt,
        expiresAt: r.expiresAt,
        current: r.id === currentSessionId,
      }));
  }

  /** `sessionId === '*'` revokes every session (including the caller's). Sweeps ADMIN_ROOM right
   * away instead of waiting for the next gated packet or the 60s sweep. */
  revoke(sessionId: string): void {
    if (sessionId === '*') this.repo.deleteAll();
    else this.repo.deleteById(sessionId);
    void this.deps.adminGuard.sweepNow();
  }

  /** The single place that mints a token + session row. Used by `pair`/`bootstrap` after their own
   * checks, and directly by `test/helpers.ts`'s `adminHeaders`/`mintAdminToken` (no pairing code or
   * same-origin dance needed in tests). Not reachable over REST/socket on its own. */
  createSession(label: string | undefined, userAgent: string | undefined): AuthTokenResponse {
    const now = Date.now();
    const { sessionIdleHours, maxSessions } = this.deps.settings.get().auth;
    this.repo.enforceMaxSessions(maxSessions);
    const token = generateAdminToken();
    const id = randomUUID();
    const expiresAt = now + sessionIdleHours * 3_600_000;
    this.repo.insert({ id, tokenHash: sha256Hex(token), label, userAgent: userAgent?.slice(0, 200), createdAt: now, lastUsedAt: now, expiresAt });
    return { token, sessionId: id, expiresAt };
  }

  // ---------------------------------------------------------------- pairing (mode: 'pairing', default)

  /** Boot-time convenience: mints and logs a code if pairing mode is on, logging is enabled, and no
   * admin session currently exists. Called once from the auth module's registration. */
  logBootPairingCodeIfNeeded(): void {
    const { mode, logPairingCodeOnBoot } = this.deps.settings.get().auth;
    if (mode !== 'pairing' || !logPairingCodeOnBoot) return;
    if (this.repo.countActive(Date.now()) > 0) return;
    const { code, url, expiresAt } = this.mintPairingCode();
    this.deps.logger.info({ code, url, expiresAt }, 'tagconn pairing code (open the URL below, or enter the code in the paired browser)');
  }

  private mintPairingCode(): PairingCodeResponse {
    const { pairingCodeTtlSec } = this.deps.settings.get().auth;
    const raw = generatePairingCode();
    this.pairing.addCode(raw, pairingCodeTtlSec * 1_000);
    const formatted = formatPairingCode(raw);
    const origin = this.deps.settings.get().server.corsOrigins[0] ?? '';
    return { code: formatted, url: `${origin}/#${PAIRING_FRAGMENT_KEY}=${formatted}`, expiresAt: Date.now() + pairingCodeTtlSec * 1_000 };
  }

  /** `POST /api/auth/pair`: redeem a one-time code (from the boot log or `pairing-codes`) for a session. */
  pair(input: PairRequest, userAgent: string | undefined): AuthTokenResponse {
    if (!this.pairing.recordAttempt()) throw new HttpError(429, 'Too many pairing attempts; try again in a minute');
    if (!this.pairing.takeCode(input.code)) throw new HttpError(401, 'Invalid, expired or already-used pairing code');
    return this.createSession(input.label, userAgent);
  }

  /** `POST /api/auth/pairing-challenge`, step 1 of the HMAC handshake used by `pnpm office:pair`. */
  pairingChallenge(nonceClient: string): PairingChallengeResponse {
    if (!this.pairing.recordAttempt()) throw new HttpError(429, 'Too many pairing attempts; try again in a minute');
    const token = this.deps.settings.get().runner.token;
    if (!token) throw new HttpError(401, 'Pairing is disabled: settings.runner.token is not configured');
    const challengeId = generateNonce();
    const nonceServer = generateNonce();
    this.pairing.addChallenge(challengeId, nonceClient, nonceServer);
    const proof = hmacProof(token, HMAC_CONTEXTS.pairing, 'server', nonceClient, nonceServer, INSTANCE_ID);
    return { challengeId, nonce: nonceServer, instanceId: INSTANCE_ID, proof };
  }

  /** `POST /api/auth/pairing-codes`, step 2: mints a fresh code once the client's proof checks out. */
  pairingCode(challengeId: string, proof: string): PairingCodeResponse {
    if (!this.pairing.recordAttempt()) throw new HttpError(429, 'Too many pairing attempts; try again in a minute');
    const token = this.deps.settings.get().runner.token;
    if (!token) throw new HttpError(401, 'Pairing is disabled: settings.runner.token is not configured');
    const challenge = this.pairing.takeChallenge(challengeId);
    if (!challenge) throw new HttpError(401, 'Unknown, expired or already-used challengeId');
    if (!verifyProof(token, HMAC_CONTEXTS.pairing, 'client', proof, challenge.nonceServer, challenge.nonceClient)) {
      throw new HttpError(401, 'Invalid proof');
    }
    return this.mintPairingCode();
  }

  // ---------------------------------------------------------------- bootstrap (mode: 'same-origin')

  /** `POST /api/auth/bootstrap`: 404 outside same-origin mode (§5.4 #6). Otherwise needs a present,
   * allowed Origin (never just "no foreign Origin", unlike the generic REST gate) and, if sent,
   * `Sec-Fetch-Site: same-origin`; refused outright when `corsOrigins` contains `'*'`. */
  bootstrap(input: BootstrapRequest, ctx: BootstrapContext): AuthTokenResponse {
    const { mode } = this.deps.settings.get().auth;
    if (mode !== 'same-origin') throw notFound('Bootstrap');
    const { corsOrigins } = this.deps.settings.get().server;
    if (corsOrigins.includes('*')) throw new HttpError(403, 'Bootstrap is refused when server.corsOrigins includes "*"');
    if (!ctx.origin || !corsOrigins.includes(ctx.origin)) throw new HttpError(403, 'Bootstrap requires a present, allowed Origin header');
    if (ctx.secFetchSite && ctx.secFetchSite !== 'same-origin') throw new HttpError(403, 'Bootstrap requires Sec-Fetch-Site: same-origin');
    return this.createSession(input.label, ctx.userAgent);
  }
}
