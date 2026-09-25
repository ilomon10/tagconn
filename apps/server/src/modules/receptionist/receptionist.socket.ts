import { ConversationCreateSchema, ReceptionistSendSchema, type ReceptionistConversation, type ReceptionistMessage } from '@tagconn/shared';
import { z } from 'zod';
import type { Deps } from '../../core/di/index.js';
import { HttpError } from '../../core/http/index.js';
import { createdByFrom } from './receptionist.caller.js';

const ConversationIdSchema = z.string().min(1).max(200);

type Ack<T> = (res: { ok: true; data: T } | { ok: false; error: string }) => void;
type Logger = Deps<'logger'>['logger'];

/** Same shape as `modules/runs/runs.socket.ts`'s `runsAck`: `HttpError`/`ZodError` messages are
 * client-safe; anything else is logged and reported generically, so a raw internal error (or a leaked
 * secret from a bug) never reaches the socket. */
function receptionistAck(logger: Logger) {
  return function <A extends unknown[], T>(fn: (...args: A) => T): (...args: [...A, Ack<T>]) => void {
    return (...args) => {
      const ack = args.pop() as unknown;
      if (typeof ack !== 'function') return;
      const reply = ack as Ack<T>;
      try {
        reply({ ok: true, data: fn(...(args as unknown as A)) });
      } catch (err) {
        if (err instanceof HttpError || err instanceof z.ZodError) {
          reply({ ok: false, error: err.message });
        } else {
          logger.error({ err }, 'unexpected error handling a receptionist socket event');
          reply({ ok: false, error: 'Internal error' });
        }
      }
    };
  };
}

/**
 * Receptionist over `/office` (docs/design/runner-and-helpdesk.md §4). REST equivalents in
 * `receptionist.routes.ts`. None of these events are in `PUBLIC_SOCKET_EVENTS`/
 * `ADMIN_SOCKET_EVENTS_WRITES`, so `core/realtime/admin-guard.ts` already refuses them without a valid
 * admin session before this handler ever runs; `who()` below just reads which session it was, for the
 * audit trail (`ReceptionistService.create`'s log line).
 */
export function registerReceptionistSocket(deps: Deps<'office' | 'receptionistService' | 'adminVerifier' | 'logger'>): void {
  const { office, receptionistService, adminVerifier } = deps;
  const ack = receptionistAck(deps.logger);

  office.on('connection', (socket) => {
    const who = () => createdByFrom(adminVerifier, socket.data.adminToken as string | undefined);

    socket.on('receptionist:list', ack((): ReceptionistConversation[] => receptionistService.list()));
    socket.on(
      'receptionist:get',
      ack((id: unknown) => receptionistService.get(ConversationIdSchema.parse(id))),
    );
    socket.on(
      'receptionist:create',
      ack((req: unknown): ReceptionistConversation => receptionistService.create(ConversationCreateSchema.parse(req), who())),
    );
    socket.on(
      'receptionist:send',
      ack((req: unknown): ReceptionistMessage => receptionistService.send(ReceptionistSendSchema.parse(req), who())),
    );
    socket.on(
      'receptionist:stop',
      ack((conversationId: unknown): true => {
        receptionistService.stop(ConversationIdSchema.parse(conversationId));
        return true;
      }),
    );
    socket.on(
      'receptionist:delete',
      ack((conversationId: unknown): true => {
        receptionistService.delete(ConversationIdSchema.parse(conversationId));
        return true;
      }),
    );
  });
}
