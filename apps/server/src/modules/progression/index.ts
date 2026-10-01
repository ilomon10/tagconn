import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { BattlesRepository } from './battles.repository.js';
import { battlesRoutes } from './battles.routes.js';
import { BattlesService } from './battles.service.js';
import { ProgressionRepository } from './progression.repository.js';
import { progressionRoutes } from './progression.routes.js';
import { ProgressionService } from './progression.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    progressionRepository: ProgressionRepository;
    battlesRepository: BattlesRepository;
    progressionService: ProgressionService;
    battlesService: BattlesService;
  }
}

/**
 * M14 hero progression (XP from agent token usage, skills, KO, loot) and turn-based battles against encounter NPCs.
 * Talks to other modules only through the event bus. See docs/design/battles.md section 2.
 */
export const progressionModule = fp(
  async (app) => {
    app.diContainer.register({
      progressionRepository: asClass(ProgressionRepository).singleton(),
      battlesRepository: asClass(BattlesRepository).singleton(),
      progressionService: asClass(ProgressionService).singleton(),
      battlesService: asClass(BattlesService).singleton(),
    });
    const { cradle } = app.diContainer;
    cradle.progressionRepository.pruneOrphans();
    cradle.progressionService.seed();
    cradle.battlesService.start(); // housekeeping timer; stop() in onClose
    // Registered after the heroes module (dependency below): heroes' agent.upserted listener runs first (load-bearing, F5).
    cradle.bus.on('hero.upserted', (h) => cradle.progressionService.onHeroUpserted(h));
    cradle.bus.on('hero.removed', ({ id }) => cradle.progressionService.onHeroRemoved(id));
    cradle.bus.on('project.merged', (m) => cradle.progressionService.onProjectMerged(m));
    cradle.bus.on('agent.upserted', (a) => cradle.progressionService.onAgentUpserted(a));
    app.addHook('onClose', async () => cradle.battlesService.stop());
    await app.register(progressionRoutes);
    await app.register(battlesRoutes);
  },
  { name: 'progression', dependencies: ['core-di', 'core-http', 'core-realtime', 'projects', 'agents', 'heroes', 'transcripts'] },
);
