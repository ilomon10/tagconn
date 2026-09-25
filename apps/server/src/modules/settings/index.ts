import fp from 'fastify-plugin';
import { settingsRoutes } from './settings.routes.js';
import { registerSettingsSocket } from './settings.socket.js';

export { toPublicSettings } from './settings.public.js';

/**
 * REST + socket front for core SettingsService. Changes are broadcast as 'settings:changed' by
 * core/realtime; modules read settings live, so most keys hot-apply.
 */
export const settingsModule = fp(
  async (app) => {
    const { cradle } = app.diContainer;
    registerSettingsSocket(cradle);
    cradle.bus.on('settings.changed', ({ changed }) => app.log.info({ changed }, 'settings changed'));
    await app.register(settingsRoutes);
  },
  { name: 'settings', dependencies: ['core-di', 'core-http', 'core-realtime'] },
);
