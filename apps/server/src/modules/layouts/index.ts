import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { LayoutsRepository } from './layouts.repository.js';
import { layoutsRoutes } from './layouts.routes.js';
import { LayoutsService } from './layouts.service.js';
import { registerLayoutsSocket } from './layouts.socket.js';

export { LayoutValidationError } from './layouts.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    layoutsRepository: LayoutsRepository;
    layoutsService: LayoutsService;
  }
}

/**
 * Office layouts (M7): DB-backed CRUD over REST and socket, a seeded read-only `DEFAULT_LAYOUT`,
 * and global broadcast (layouts aren't per floor). See docs/design/guild-hall.md §7.
 */
export const layoutsModule = fp(
  async (app) => {
    app.diContainer.register({
      layoutsRepository: asClass(LayoutsRepository).singleton(),
      layoutsService: asClass(LayoutsService).singleton(),
    });
    app.diContainer.cradle.layoutsService.seedDefault();
    registerLayoutsSocket(app.diContainer.cradle);
    await app.register(layoutsRoutes);
  },
  { name: 'layouts', dependencies: ['core-di', 'core-http', 'core-realtime'] },
);
