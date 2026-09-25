import { LayoutAssignSchema, OfficeLayoutInputSchema, type OfficeLayout, type Project } from '@tagconn/shared';
import { z } from 'zod';
import type { Deps } from '../../core/di/index.js';
import { HttpError } from '../../core/http/index.js';
import { LayoutValidationError } from './layouts.service.js';

type Ack<T> = (res: { ok: true; data: T } | { ok: false; error: string }) => void;
type Logger = Deps<'logger'>['logger'];

/** Loose on purpose, like the REST GET/DELETE params (an id that doesn't match `LAYOUT_ID_RE` just
 * won't be found); mainly guards against a non-string payload reaching the repository. */
const LayoutIdSchema = z.string().min(1).max(64);

/**
 * Same shape as `core/realtime`'s `ackify`, except:
 * - a `LayoutValidationError` reports `issues.map(i => i.message).join('; ')` instead of the generic
 *   "Invalid layout" message, per the socket contract in docs/design/guild-hall.md §7 (REST keeps
 *   "Invalid layout" plus `details`);
 * - only `HttpError`/`LayoutValidationError`/`ZodError` messages (all deliberately client-safe) are
 *   sent to the client; anything else is logged server-side and reported as a generic message, so a
 *   raw driver/internal error (e.g. SQLite) never reaches the socket.
 */
function layoutAck(logger: Logger) {
  return function <A extends unknown[], T>(fn: (...args: A) => T): (...args: [...A, Ack<T>]) => void {
    return (...args) => {
      const ack = args.pop() as unknown;
      if (typeof ack !== 'function') return;
      const reply = ack as Ack<T>;
      try {
        reply({ ok: true, data: fn(...(args as unknown as A)) });
      } catch (err) {
        if (err instanceof LayoutValidationError) {
          reply({ ok: false, error: err.issues.map((i) => i.message).join('; ') });
        } else if (err instanceof HttpError || err instanceof z.ZodError) {
          reply({ ok: false, error: err.message });
        } else {
          logger.error({ err }, 'unexpected error handling a layouts socket event');
          reply({ ok: false, error: 'Internal error' });
        }
      }
    };
  };
}

/**
 * `projectsService` (for `layouts:assign`) is read lazily off `deps` inside each handler, not
 * destructured up front, so this module never depends on the projects module's registration order.
 */
export function registerLayoutsSocket(deps: Deps<'office' | 'layoutsService' | 'projectsService' | 'logger'>): void {
  const { office, layoutsService } = deps;
  const ack = layoutAck(deps.logger);
  office.on('connection', (socket) => {
    socket.on('layouts:list', ack((): OfficeLayout[] => layoutsService.list()));
    socket.on('layouts:get', ack((id: unknown): OfficeLayout => layoutsService.get(LayoutIdSchema.parse(id))));
    socket.on(
      'layouts:save',
      ack((input: unknown): OfficeLayout => {
        const layout = OfficeLayoutInputSchema.parse(input);
        return layout.id !== undefined ? layoutsService.replace(layout.id, layout) : layoutsService.create(layout);
      }),
    );
    socket.on(
      'layouts:delete',
      ack((id: unknown): true => {
        layoutsService.delete(LayoutIdSchema.parse(id));
        return true;
      }),
    );
    socket.on(
      'layouts:assign',
      ack((req: unknown): Project => {
        const { projectId, layoutId } = LayoutAssignSchema.parse(req);
        return deps.projectsService.assignLayout(projectId, layoutId);
      }),
    );
  });
}
