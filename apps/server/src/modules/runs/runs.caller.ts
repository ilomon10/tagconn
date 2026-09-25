import type { AdminVerifier } from '../../core/http/index.js';

/**
 * `Run.createdBy` (audit only, never an authorization check — S1's `adminVerifier`/access gating is
 * what actually protects `/api/runs*` and the `runs:*` socket events). Resolves to the real admin
 * session id when the presented token verifies, else a fixed sentinel (requests reach here at all
 * only because they already passed the access gate, so this is just "whose session was it").
 */
export function createdByFrom(adminVerifier: AdminVerifier, token: string | undefined): string {
  const check = adminVerifier.verify(token);
  return check.ok && check.sessionId ? check.sessionId : 'unknown';
}
