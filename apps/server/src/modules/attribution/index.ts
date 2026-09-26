import { rooms } from '@tagconn/shared';
import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { AttributionRepository } from './attribution.repository.js';
import { attributionRoutes } from './attribution.routes.js';
import { AttributionService } from './attribution.service.js';
import { registerAttributionSocket } from './attribution.socket.js';

declare module '@fastify/awilix' {
  interface Cradle {
    attributionRepository: AttributionRepository;
    attributionService: AttributionService;
  }
}

/**
 * M8 8j attribution: validates and (with consent) applies a project's `.tagconn/office.json` profile
 * posted by the hook on `SessionStart`. REST `/api/attribution/*` + socket `attribution:*`. See
 * docs/design/runner-and-helpdesk.md §6 (task S4).
 */
export const attributionModule = fp(
  async (app) => {
    app.diContainer.register({
      attributionRepository: asClass(AttributionRepository).singleton(),
      attributionService: asClass(AttributionService).singleton(),
    });
    const { cradle } = app.diContainer;

    // Admin-only broadcast (same pattern as runs/receptionist): pending imports are shown as a toast
    // only to admin sessions, never broadcast per-floor.
    cradle.bus.on('attribution.pending', (p) => cradle.office.to(rooms.admin).emit('attribution:pending', p));
    cradle.bus.on('attribution.pendingCleared', (projectId) => cradle.office.to(rooms.admin).emit('attribution:pendingCleared', projectId));

    registerAttributionSocket(cradle);
    await app.register(attributionRoutes);
  },
  // 'runs' (§6.4): `save()` forwards `attribution:write` to the verified runner via `runsService`.
  { name: 'attribution', dependencies: ['core-di', 'core-http', 'core-realtime', 'projects', 'sessions', 'roles', 'layouts', 'heroes', 'runs'] },
);
