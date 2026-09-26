import type { AttributionResolve, PendingProfileImport } from '@tagconn/shared';
import { emitWithAckTimeout } from '../../lib/socket';

/**
 * Typed wrappers around the `attribution:*` acked socket events (docs/design/runner-and-helpdesk.md
 * section 6.3). Both events are always-admin-gated (`ADMIN_SOCKET_EVENTS_EXECUTION`), so a denied
 * caller never acks at all — a short timeout here is the signal "not authorized", same convention as
 * `lib/socket.ts`'s `authSocket` (decision #20: a plain timer, not socket.io's built-in ack timeout).
 */
const ATTRIBUTION_ACK_TIMEOUT_MS = 4_000;

export function listPendingImports(): Promise<PendingProfileImport[]> {
  return emitWithAckTimeout(ATTRIBUTION_ACK_TIMEOUT_MS, 'attribution:pendingList');
}

export function resolvePendingImport(projectId: string, action: AttributionResolve['action']): Promise<true> {
  return emitWithAckTimeout(ATTRIBUTION_ACK_TIMEOUT_MS, 'attribution:resolve', { projectId, action });
}
