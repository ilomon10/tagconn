import fp from 'fastify-plugin';
import { healthRoutes } from './health.routes.js';

export const healthModule = fp(
  async (app) => {
    await app.register(healthRoutes);
  },
  { name: 'health', dependencies: ['core-http'] },
);
