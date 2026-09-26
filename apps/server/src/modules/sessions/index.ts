import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { SessionsRepository } from './sessions.repository.js';
import { SessionsService } from './sessions.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    sessionsRepository: SessionsRepository;
    sessionsService: SessionsService;
  }
}

/** Session lifecycle (active / idle / ended). Runs after projects on 'hook.received'. */
export const sessionsModule = fp(
  async (app) => {
    app.diContainer.register({
      sessionsRepository: asClass(SessionsRepository).singleton(),
      sessionsService: asClass(SessionsService).singleton(),
    });
    const { bus, sessionsService } = app.diContainer.cradle;
    bus.on('hook.received', (ctx) => sessionsService.onHook(ctx));
    // S5, §2.6 "Authoritative": the run -> session side of the link (runs emits this from a run's own
    // `init` event, or from the header hint it echoed back). See `onRunLinked` for both hook/run orders.
    bus.on('run.linked', (e) => sessionsService.onRunLinked(e));
    app.addHook('onReady', async () => sessionsService.start());
    app.addHook('onClose', async () => sessionsService.stop());
  },
  { name: 'sessions', dependencies: ['core-di', 'projects'] },
);
