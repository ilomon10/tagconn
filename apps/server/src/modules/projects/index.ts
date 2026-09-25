import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { projectsRoutes } from './projects.routes.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectsService } from './projects.service.js';

export { projectIdFor } from './projects.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    projectsRepository: ProjectsRepository;
    projectsService: ProjectsService;
  }
}

/** One floor per working directory. First 'hook.received' listener: sets ctx.projectId. */
export const projectsModule = fp(
  async (app) => {
    app.diContainer.register({
      projectsRepository: asClass(ProjectsRepository).singleton(),
      projectsService: asClass(ProjectsService).singleton(),
    });
    const { bus, projectsService } = app.diContainer.cradle;
    bus.on('hook.received', (ctx) => projectsService.onHook(ctx));
    await app.register(projectsRoutes);
  },
  { name: 'projects', dependencies: ['core-di', 'core-http', 'ingest'] },
);
