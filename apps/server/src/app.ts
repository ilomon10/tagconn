import type { SettingsPatch } from '@tagconn/shared';
import Fastify, { type FastifyServerOptions } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { deepMerge, type LoadedConfig, loadConfig, type PlainObject } from './core/config/index.js';
import { diPlugin } from './core/di/index.js';
import { httpPlugin } from './core/http/index.js';
import { realtimePlugin } from './core/realtime/index.js';
import { activityModule } from './modules/activity/index.js';
import { agentsModule } from './modules/agents/index.js';
import { eventsModule } from './modules/events/index.js';
import { healthModule } from './modules/health/index.js';
import { ingestModule } from './modules/ingest/index.js';
import { layoutsModule } from './modules/layouts/index.js';
import { projectsModule } from './modules/projects/index.js';
import { rolesModule } from './modules/roles/index.js';
import { resolveTemplatesDir } from './modules/roles/roles.templates.js';
import { sessionsModule } from './modules/sessions/index.js';
import { settingsModule } from './modules/settings/index.js';
import { snapshotModule } from './modules/snapshot/index.js';
import { tasksModule } from './modules/tasks/index.js';
import { transcriptsModule } from './modules/transcripts/index.js';

export interface BuildAppOptions {
  /** Pre-loaded config (main.ts). Otherwise loaded from configFile/env below. */
  config?: LoadedConfig;
  /** YAML file to load, or false to skip file loading (tests). */
  configFile?: string | false;
  env?: Record<string, string | undefined>;
  /** Extra settings layer (after env, not persisted). */
  settings?: SettingsPatch;
  /** Shortcut for settings.storage.dbPath, e.g. ':memory:'. */
  dbPath?: string;
  templatesDir?: string;
  logger?: FastifyServerOptions['logger'];
}

function defaultLogger(level: string): FastifyServerOptions['logger'] {
  const pretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production';
  if (!pretty) return { level };
  try {
    import.meta.resolve('pino-pretty');
    return { level, transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } };
  } catch {
    return { level };
  }
}

export async function buildApp(opts: BuildAppOptions = {}) {
  const env = opts.env ?? process.env;
  let overrides = (opts.settings ?? {}) as PlainObject;
  if (opts.dbPath) overrides = deepMerge(overrides, { storage: { dbPath: opts.dbPath } });
  let config = opts.config ?? loadConfig({ configFile: opts.configFile, env, overrides });
  if (opts.config && Object.keys(overrides).length > 0) {
    const layered = deepMerge(opts.config.layered, overrides);
    config = { ...loadConfig({ configFile: false, env: {}, overrides: layered }), configFile: opts.config.configFile };
  }

  const app = Fastify({
    logger: opts.logger ?? defaultLogger(config.base.server.logLevel),
    bodyLimit: config.base.ingest.maxPayloadBytes,
  }).withTypeProvider<ZodTypeProvider>();

  // Core (order matters: DI first; every other plugin resolves from the container).
  await app.register(diPlugin, { config, templatesDir: opts.templatesDir ?? resolveTemplatesDir(env) });
  await app.register(httpPlugin);
  await app.register(realtimePlugin);

  // Modules. 'hook.received' listeners run in this registration order:
  // projects → sessions → agents → transcripts → tasks → events.
  await app.register(healthModule);
  await app.register(settingsModule);
  await app.register(activityModule);
  await app.register(rolesModule);
  await app.register(layoutsModule);
  await app.register(ingestModule);
  await app.register(projectsModule);
  await app.register(sessionsModule);
  await app.register(agentsModule);
  await app.register(transcriptsModule);
  await app.register(tasksModule);
  await app.register(eventsModule);
  await app.register(snapshotModule);

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
