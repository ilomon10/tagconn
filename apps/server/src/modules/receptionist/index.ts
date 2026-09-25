import { rooms } from '@tagconn/shared';
import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { ReceptionistRepository } from './receptionist.repository.js';
import { receptionistRoutes } from './receptionist.routes.js';
import { ReceptionistService } from './receptionist.service.js';
import { registerReceptionistSocket } from './receptionist.socket.js';

declare module '@fastify/awilix' {
  interface Cradle {
    receptionistRepository: ReceptionistRepository;
    receptionistService: ReceptionistService;
  }
}

/**
 * M8 8l Receptionist help desk: conversations and messages for the read-only NPC at the Guild Gate,
 * REST `/api/receptionist*` + socket `receptionist:*` (both always `admin`, docs/design/
 * runner-and-helpdesk.md §5.3), backed by the `runDispatcher` port `modules/runs` (S2) registers. See
 * §4 and §9 (task S3).
 */
export const receptionistModule = fp(
  async (app) => {
    app.diContainer.register({
      receptionistRepository: asClass(ReceptionistRepository).singleton(),
      receptionistService: asClass(ReceptionistService).singleton(),
    });
    const { cradle } = app.diContainer;

    // Projects the runner's event/status stream onto conversations/messages (§2.5, §2.6); admin-only
    // broadcast, like runs (§5.3: "Admin broadcasts go only to ADMIN_ROOM").
    cradle.bus.on('run.event', (e) => cradle.receptionistService.onRunEvent(e));
    cradle.bus.on('run.upserted', (r) => cradle.receptionistService.onRunUpserted(r));
    cradle.bus.on('receptionist.conversationUpserted', (c) => cradle.office.to(rooms.admin).emit('receptionist:conversation', c));
    cradle.bus.on('receptionist.conversationRemoved', (id) => cradle.office.to(rooms.admin).emit('receptionist:conversationRemoved', id));
    cradle.bus.on('receptionist.messageUpserted', (m) => cradle.office.to(rooms.admin).emit('receptionist:message', m));

    registerReceptionistSocket(cradle);
    await app.register(receptionistRoutes);
  },
  { name: 'receptionist', dependencies: ['core-di', 'core-http', 'core-realtime', 'projects', 'runs'] },
);
