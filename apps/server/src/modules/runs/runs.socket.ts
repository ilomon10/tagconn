import {
  RunFollowUpRequestSchema,
  RunListQuerySchema,
  RunStartRequestSchema,
  type Run,
  type RunDetail,
  type RunnerStatus,
} from '@tagconn/shared';
import { z } from 'zod';
import type { Deps } from '../../core/di/index.js';
import { HttpError } from '../../core/http/index.js';
import { createdByFrom } from './runs.caller.js';

const RunIdSchema = z.string().regex(/^[0-9a-f-]{36}$/);

type Ack<T> = (res: { ok: true; data: T } | { ok: false; error: string }) => void;
type Logger = Deps<'logger'>['logger'];

/** Same shape as `ackify`/`layoutAck`: `HttpError`/`ZodError` messages are client-safe; anything
 * else is logged and reported generically, so a raw internal error never reaches the socket. */
function runsAck(logger: Logger) {
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
          logger.error({ err }, 'unexpected error handling a runs socket event');
          reply({ ok: false, error: 'Internal error' });
        }
      }
    };
  };
}

/**
 * Quest board over `/office` (docs/design/runner-and-helpdesk.md §3). REST equivalents in
 * `runs.routes.ts`. These events are not in `PUBLIC_SOCKET_EVENTS`/`ADMIN_SOCKET_EVENTS_WRITES`, so
 * `core/realtime/admin-guard.ts` already refuses them without a valid admin session before this
 * handler ever runs; `who()` below just reads which session it was, for the audit trail.
 */
export function registerRunsSocket(deps: Deps<'office' | 'runsService' | 'adminVerifier' | 'logger'>): void {
  const { office, runsService, adminVerifier } = deps;
  const ack = runsAck(deps.logger);

  office.on('connection', (socket) => {
    const who = () => createdByFrom(adminVerifier, socket.data.adminToken as string | undefined);

    socket.on('runs:list', ack((q: unknown): Run[] => runsService.list(RunListQuerySchema.parse(q))));
    socket.on('runs:get', ack((runId: unknown): RunDetail => runsService.getDetail(RunIdSchema.parse(runId))));
    socket.on('runs:start', ack((req: unknown): Run => runsService.startQuest(RunStartRequestSchema.parse(req), who())));
    socket.on('runs:followUp', ack((req: unknown): Run => runsService.followUp(RunFollowUpRequestSchema.parse(req), who())));
    socket.on('runs:stop', ack((runId: unknown): Run => runsService.stopQuest(RunIdSchema.parse(runId), who())));
    socket.on('runner:getStatus', ack((): RunnerStatus => runsService.getRunnerStatus()));
  });
}
