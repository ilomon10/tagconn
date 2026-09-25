import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { HeroesRepository } from './heroes.repository.js';
import { heroesRoutes } from './heroes.routes.js';
import { HeroesService } from './heroes.service.js';
import { registerHeroesSocket } from './heroes.socket.js';

declare module '@fastify/awilix' {
  interface Cradle {
    heroesRepository: HeroesRepository;
    heroesService: HeroesService;
  }
}

/**
 * Named, persistent hero identities bound to live agents (M8 8i): DB-backed CRUD over REST and
 * socket, plus binding driven purely by the event bus (`agent.upserted` / `agent.removed`), so this
 * module never imports the agents module's internals. See docs/design/living-office.md section 3.
 */
export const heroesModule = fp(
  async (app) => {
    app.diContainer.register({
      heroesRepository: asClass(HeroesRepository).singleton(),
      heroesService: asClass(HeroesService).singleton(),
    });
    const { cradle } = app.diContainer;
    cradle.heroesService.seed();
    cradle.bus.on('agent.upserted', (a) => cradle.heroesService.onAgentUpserted(a));
    cradle.bus.on('agent.removed', ({ id }) => cradle.heroesService.onAgentRemoved(id));
    registerHeroesSocket(cradle);
    await app.register(heroesRoutes);
  },
  { name: 'heroes', dependencies: ['core-di', 'core-http', 'core-realtime', 'projects', 'roles', 'agents'] },
);
