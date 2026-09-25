import { type Cradle, fastifyAwilixPlugin } from '@fastify/awilix';
import { asValue, createContainer, InjectionMode } from 'awilix';
import type { FastifyBaseLogger } from 'fastify';
import fp from 'fastify-plugin';
import type { LoadedConfig } from '../config/index.js';
import { SettingsService } from '../config/index.js';
import { type Db, DbSettingsStore, openDb } from '../db/index.js';
import { EventBus } from '../event-bus/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: LoadedConfig;
    logger: FastifyBaseLogger;
    db: Db;
    bus: EventBus;
    settings: SettingsService;
    /** Directory holding the default role markdown files (may be undefined if not found). */
    templatesDir: string | undefined;
  }
}

/** Pick<Cradle, K>: what a class declares it needs from the container. */
export type Deps<K extends keyof Cradle> = Pick<Cradle, K>;

export interface CoreDiOptions {
  config: LoadedConfig;
  templatesDir: string | undefined;
}

/**
 * Per-app awilix container (never the module-global one, so several apps can run in one test process)
 * holding the core singletons: config, logger, db, bus, settings. Modules register their own
 * repositories/services into it.
 */
export const diPlugin = fp<CoreDiOptions>(
  async (app, opts) => {
    const container = createContainer<Cradle>({ injectionMode: InjectionMode.PROXY, strict: true });
    await app.register(fastifyAwilixPlugin, {
      container,
      disposeOnClose: true,
      disposeOnResponse: false,
      strictBooleanEnforced: true,
    });

    const handle = openDb(opts.config.base.storage.dbPath);
    const bus = new EventBus((err, event) => app.log.error({ err, event }, 'event bus listener failed'));
    const settings = new SettingsService(opts.config.layered, new DbSettingsStore(handle.db), bus, (err) =>
      app.log.warn({ err }, 'stored settings overrides are invalid; ignoring them'),
    );

    container.register({
      config: asValue(opts.config),
      logger: asValue(app.log),
      db: asValue(handle.db),
      bus: asValue(bus),
      settings: asValue(settings),
      templatesDir: asValue(opts.templatesDir),
    });

    app.addHook('onClose', async () => {
      bus.clear();
      handle.close();
    });
  },
  { name: 'core-di', fastify: '5.x' },
);
