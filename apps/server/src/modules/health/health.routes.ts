import type { FastifyPluginAsync } from 'fastify';
import pkg from '../../../package.json';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/health', async () => ({ ok: true, version: pkg.version, uptime: Math.round(process.uptime()) }));
};
