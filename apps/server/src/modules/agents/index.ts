import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { AgentsRepository } from './agents.repository.js';
import { AgentsService } from './agents.service.js';

export { publicAgent } from './agents.repository.js';
export { DEFAULT_SUBAGENT_TYPE, mainAgentId } from './agents.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    agentsRepository: AgentsRepository;
    agentsService: AgentsService;
  }
}

/** Characters: state machine over hooks + idle/removal sweeper. Sets ctx.agentId for later listeners. */
export const agentsModule = fp(
  async (app) => {
    app.diContainer.register({
      agentsRepository: asClass(AgentsRepository).singleton(),
      agentsService: asClass(AgentsService).singleton(),
    });
    const { bus, agentsService } = app.diContainer.cradle;
    bus.on('hook.received', (ctx) => agentsService.onHook(ctx));
    app.addHook('onReady', async () => agentsService.start());
    app.addHook('onClose', async () => agentsService.stop());
  },
  { name: 'agents', dependencies: ['core-di', 'sessions', 'activity', 'roles'] },
);
