import { AttributionResolveSchema, AttributionSaveSchema, type AttributionWriteResult, type PendingProfileImport } from '@tagconn/shared';
import { z } from 'zod';
import type { Deps } from '../../core/di/index.js';
import { HttpError } from '../../core/http/index.js';
import { ackify } from '../../core/realtime/index.js';

type Ack<T> = (res: { ok: true; data: T } | { ok: false; error: string }) => void;

/**
 * Same error-mapping convention as `runs.socket.ts`'s `runsAck`: an `HttpError`/`ZodError` message is
 * client-safe (dir not allowed, runner disabled/offline, a runner-side refusal); anything else is
 * logged and reported generically so a raw internal error never reaches the socket. Async (unlike
 * `ackify`) because `attribution:save` waits on the runner's own `attribution:write` ack.
 */
function asyncAttributionAck(logger: Deps<'logger'>['logger']) {
  return function <A extends unknown[], T>(fn: (...args: A) => Promise<T>): (...args: [...A, Ack<T>]) => void {
    return (...args) => {
      const ack = args.pop() as unknown;
      if (typeof ack !== 'function') return;
      const reply = ack as Ack<T>;
      fn(...(args as unknown as A)).then(
        (data) => reply({ ok: true, data }),
        (err: unknown) => {
          if (err instanceof HttpError || err instanceof z.ZodError) {
            reply({ ok: false, error: err.message });
          } else {
            logger.error({ err }, 'unexpected error handling attribution:save');
            reply({ ok: false, error: 'Internal error' });
          }
        },
      );
    };
  };
}

/**
 * `attribution:pendingList` / `attribution:resolve` / `attribution:save` (M8 8j/8k/8l, S4). All three
 * are outside `PUBLIC_SOCKET_EVENTS` and `ADMIN_SOCKET_EVENTS_WRITES`, so `core/realtime/admin-guard.ts`
 * always gates them (fail closed). `attribution:save` forwards to the verified host runner's
 * `attribution:write` (§6.4); `attributionService.save` throws a client-safe `HttpError` for every
 * refusal (runner disabled/offline, project dir not allowed, a runner-side refusal).
 */
export function registerAttributionSocket({ office, attributionService, logger }: Deps<'office' | 'attributionService' | 'logger'>): void {
  const asyncAck = asyncAttributionAck(logger);

  office.on('connection', (socket) => {
    socket.on('attribution:pendingList', ackify((): PendingProfileImport[] => attributionService.pendingList()));
    socket.on(
      'attribution:resolve',
      ackify((req: unknown): true => {
        const { projectId, action } = AttributionResolveSchema.parse(req);
        return attributionService.resolve(projectId, action);
      }),
    );
    socket.on(
      'attribution:save',
      asyncAck((req: unknown): Promise<AttributionWriteResult> => {
        const { projectId, overwrite } = AttributionSaveSchema.parse(req);
        return attributionService.save(projectId, overwrite);
      }),
    );
  });
}
