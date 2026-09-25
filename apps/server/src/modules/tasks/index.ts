import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { TasksRepository } from './tasks.repository.js';
import { TasksService } from './tasks.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    tasksRepository: TasksRepository;
    tasksService: TasksService;
  }
}

/** Kanban cards from Agent tool calls (+ handoff results) and TodoWrite lists. Runs after agents. */
export const tasksModule = fp(
  async (app) => {
    app.diContainer.register({
      tasksRepository: asClass(TasksRepository).singleton(),
      tasksService: asClass(TasksService).singleton(),
    });
    const { bus, tasksService } = app.diContainer.cradle;
    bus.on('hook.received', (ctx) => tasksService.onHook(ctx));
  },
  { name: 'tasks', dependencies: ['core-di', 'agents'] },
);
