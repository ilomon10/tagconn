import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { HttpError } from '../../core/http/index.js';
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
    const { cradle } = app.diContainer;
    cradle.layoutsService.seedDefault();
    // Cross-module check: core/config can't import this module, so it exposes a validator
    // registry instead. Only applies to later settings.update()/reset() calls (see SettingsService).
    cradle.settings.addValidator((s) => {
      const id = s.office.defaultLayoutId;
      if (!cradle.layoutsRepository.get(id)) throw new HttpError(400, `office.defaultLayoutId "${id}" is not an existing layout`);
    });
    registerLayoutsSocket(cradle);
    await app.register(layoutsRoutes);
  },
  { name: 'layouts', dependencies: ['core-di', 'core-http', 'core-realtime'] },
);
