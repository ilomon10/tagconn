import type { SettingsPatch } from '@tagconn/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { SettingsPatchBodySchema } from './settings.schema.js';
import { toPublicSettings } from './settings.public.js';

export const settingsRoutes: FastifyPluginAsyncZod = async (app) => {
  const { settings } = app.diContainer.cradle;

  app.get('/api/settings', async () => toPublicSettings(settings.get()));

  app.patch('/api/settings', { schema: { body: SettingsPatchBodySchema } }, async (req) => {
    const { settings: next, restartRequired } = settings.update(req.body as SettingsPatch);
    return { settings: toPublicSettings(next), restartRequired };
  });

  app.post('/api/settings/reset', async () => {
    const { settings: next, restartRequired } = settings.reset();
    return { settings: toPublicSettings(next), restartRequired };
  });
};
