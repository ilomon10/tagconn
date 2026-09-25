import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { eventsRoutes } from './events.routes.js';
import { EventsRepository } from './events.repository.js';
import { EventsService } from './events.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    eventsRepository: EventsRepository;
    eventsService: EventsService;
  }
}

/** Event log: one OfficeEvent per hook (last 'hook.received' listener), hourly retention. */
export const eventsModule = fp(
  async (app) => {
    app.diContainer.register({
      eventsRepository: asClass(EventsRepository).singleton(),
      eventsService: asClass(EventsService).singleton(),
    });
    const { bus, eventsService } = app.diContainer.cradle;
    bus.on('hook.received', (ctx) => eventsService.onHook(ctx));
    app.addHook('onReady', async () => eventsService.start());
    app.addHook('onClose', async () => eventsService.stop());
    await app.register(eventsRoutes);
  },
  { name: 'events', dependencies: ['core-di', 'core-http', 'agents', 'tasks'] },
);
