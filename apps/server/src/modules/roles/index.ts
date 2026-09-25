import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { RolesRepository } from './roles.repository.js';
import { rolesRoutes } from './roles.routes.js';
import { RolesService } from './roles.service.js';
import { registerRolesSocket } from './roles.socket.js';

declare module '@fastify/awilix' {
  interface Cradle {
    rolesRepository: RolesRepository;
    rolesService: RolesService;
  }
}

/** Office staff roles: DB-backed CRUD, seeded from templates, mirrored into settings.paths.agentsDir. */
export const rolesModule = fp(
  async (app) => {
    app.diContainer.register({
      rolesRepository: asClass(RolesRepository).singleton(),
      rolesService: asClass(RolesService).singleton(),
    });
    const { cradle } = app.diContainer;
    cradle.rolesService.seed();
    cradle.bus.on('settings.changed', ({ changed }) => {
      if (changed.includes('paths.agentsDir')) cradle.rolesService.autoSync();
    });
    registerRolesSocket(cradle);
    await app.register(rolesRoutes);
  },
  { name: 'roles', dependencies: ['core-di', 'core-http', 'core-realtime'] },
);
