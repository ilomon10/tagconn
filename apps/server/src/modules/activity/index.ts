import { asClass } from 'awilix';
import fp from 'fastify-plugin';
import { ActivityService } from './activity.service.js';

export { mapRule } from './activity.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    activityService: ActivityService;
  }
}

/** Tool call → activity/zone/bubble mapping (pure rules from settings.activity.rules). */
export const activityModule = fp(
  async (app) => {
    app.diContainer.register({ activityService: asClass(ActivityService).singleton() });
  },
  { name: 'activity', dependencies: ['core-di'] },
);
