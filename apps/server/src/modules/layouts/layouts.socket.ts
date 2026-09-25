import { LayoutAssignSchema, OfficeLayoutInputSchema, type OfficeLayout, type Project } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { LayoutValidationError } from './layouts.service.js';

type Ack<T> = (res: { ok: true; data: T } | { ok: false; error: string }) => void;

/**
 * Same shape as `core/realtime`'s `ackify`, except a `LayoutValidationError` reports
 * `issues.map(i => i.message).join('; ')` instead of the generic "Invalid layout" message, per the
 * socket contract in docs/design/guild-hall.md §7 (REST keeps "Invalid layout" plus `details`).
 */
function layoutAck<A extends unknown[], T>(fn: (...args: A) => T): (...args: [...A, Ack<T>]) => void {
  return (...args) => {
    const ack = args.pop() as unknown;
    if (typeof ack !== 'function') return;
    const reply = ack as Ack<T>;
    try {
      reply({ ok: true, data: fn(...(args as unknown as A)) });
    } catch (err) {
      if (err instanceof LayoutValidationError) {
        reply({ ok: false, error: err.issues.map((i) => i.message).join('; ') });
      } else {
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
}

/**
 * `projectsService` (for `layouts:assign`) is read lazily off `deps` inside each handler, not
 * destructured up front, so this module never depends on the projects module's registration order.
 */
export function registerLayoutsSocket(deps: Deps<'office' | 'layoutsService' | 'projectsService'>): void {
  const { office, layoutsService } = deps;
  office.on('connection', (socket) => {
    socket.on('layouts:list', layoutAck((): OfficeLayout[] => layoutsService.list()));
    socket.on('layouts:get', layoutAck((id: string): OfficeLayout => layoutsService.get(id)));
    socket.on(
      'layouts:save',
      layoutAck((input: unknown): OfficeLayout => {
        const layout = OfficeLayoutInputSchema.parse(input);
        return layout.id !== undefined ? layoutsService.replace(layout.id, layout) : layoutsService.create(layout);
      }),
    );
    socket.on(
      'layouts:delete',
      layoutAck((id: string): true => {
        layoutsService.delete(id);
        return true;
      }),
    );
    socket.on(
      'layouts:assign',
      layoutAck((req: unknown): Project => {
        const { projectId, layoutId } = LayoutAssignSchema.parse(req);
        return deps.projectsService.assignLayout(projectId, layoutId);
      }),
    );
  });
}
