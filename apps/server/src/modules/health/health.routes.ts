import type { FastifyPluginAsync } from 'fastify';
import pkg from '../../../package.json';
import { INSTANCE_ID } from './health.instance.js';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/health', { config: { access: 'public' } }, async () => ({
    ok: true,
    version: pkg.version,
    uptime: Math.round(process.uptime()),
    // Per-boot, not per-request; see health.instance.ts.
    instanceId: INSTANCE_ID,
  }));
};
