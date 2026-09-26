import type { ConversationCreate, ReceptionistMessage, RunnerStatus } from '@tagconn/shared';
import { AckError, AckTimeoutError, emitWithAckTimeout } from '../../lib/socket';

/**
 * Thin typed wrappers around the acked `receptionist:*` (and `runner:getStatus`) socket events, kept
 * in this feature's own module rather than growing `lib/socket.ts` (docs/decisions.md #20: acked
 * calls always go through `emitWithAckTimeout`, never socket.io's own `.timeout()`). Every one of
 * these events is always admin-gated server-side (`packages/shared/src/auth.ts`
 * `ADMIN_SOCKET_EVENTS_EXECUTION`): a denied call never acks at all, so `AckTimeoutError` here means
 * "not authorized" rather than a slow network (same convention `authSocket` in `lib/socket.ts` uses).
 */

const ACK_TIMEOUT_MS = 10_000;
/** Runner status is checked opportunistically for the "runner offline" banner; a short timeout keeps
 *  that check from stalling the panel if it's ever called without an admin session. */
const RUNNER_STATUS_TIMEOUT_MS = 4_000;

export { AckError, AckTimeoutError };

export const receptionistApi = {
  list: () => emitWithAckTimeout(ACK_TIMEOUT_MS, 'receptionist:list'),
  get: (id: string) => emitWithAckTimeout(ACK_TIMEOUT_MS, 'receptionist:get', id),
  create: (req: ConversationCreate) => emitWithAckTimeout(ACK_TIMEOUT_MS, 'receptionist:create', req),
  send: (conversationId: string, text: string): Promise<ReceptionistMessage> =>
    emitWithAckTimeout(ACK_TIMEOUT_MS, 'receptionist:send', { conversationId, text }),
  stop: (conversationId: string) => emitWithAckTimeout(ACK_TIMEOUT_MS, 'receptionist:stop', conversationId),
  delete: (conversationId: string) => emitWithAckTimeout(ACK_TIMEOUT_MS, 'receptionist:delete', conversationId),
  runnerStatus: (): Promise<RunnerStatus> => emitWithAckTimeout(RUNNER_STATUS_TIMEOUT_MS, 'runner:getStatus'),
};
