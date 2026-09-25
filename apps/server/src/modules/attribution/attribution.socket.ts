import { AttributionResolveSchema, type PendingProfileImport } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { ackify } from '../../core/realtime/index.js';

/**
 * `attribution:pendingList` / `attribution:resolve` (M8 8j, S4). Both are outside `PUBLIC_SOCKET_EVENTS`
 * and `ADMIN_SOCKET_EVENTS_WRITES`, so `core/realtime/admin-guard.ts` always gates them (fail closed).
 * `attribution:save` needs the v2 host runner (R1, not built yet: see docs/design/runner-and-helpdesk.md
 * §6.4); it acks a clear "not implemented" error for now instead of silently doing nothing.
 */
export function registerAttributionSocket({ office, attributionService }: Deps<'office' | 'attributionService'>): void {
  office.on('connection', (socket) => {
    socket.on('attribution:pendingList', ackify((): PendingProfileImport[] => attributionService.pendingList()));
    socket.on(
      'attribution:resolve',
      ackify((req: unknown): true => {
        const { projectId, action } = AttributionResolveSchema.parse(req);
        return attributionService.resolve(projectId, action);
      }),
    );
    socket.on('attribution:save', (_req: unknown, ack: (res: { ok: false; error: string }) => void) => {
      if (typeof ack === 'function') ack({ ok: false, error: 'Not implemented: saving to the repo needs the host runner (M8 8k, not built yet)' });
    });
  });
}
