import type { AdminVerifier } from '../../core/http/index.js';

/**
 * `ReceptionistConversation`/message audit trail only — never an authorization check (S1's
 * `adminVerifier`/access gating already protects every `/api/receptionist*` route and every
 * `receptionist:*` socket event; see `receptionist.routes.ts`/`receptionist.socket.ts`). Same shape as
 * `modules/runs/runs.caller.ts`'s `createdByFrom`, duplicated rather than imported so this module never
 * reaches into another module's internals (see CLAUDE.md conventions).
 */
export function createdByFrom(adminVerifier: AdminVerifier, token: string | undefined): string {
  const check = adminVerifier.verify(token);
  return check.ok && check.sessionId ? check.sessionId : 'unknown';
}
