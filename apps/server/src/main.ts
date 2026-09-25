import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { loadConfig } from './core/config/index.js';

/**
 * `pnpm dev` runs from apps/server with no shell-level env loaded, so OFFICE_HOOK_TOKEN (and any
 * other override) would silently be empty. Load a `.env` next to the cwd or the repo root, without
 * clobbering anything already set (`process.loadEnvFile` never overrides existing env vars).
 */
function loadDotEnv(): void {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
  const file = candidates.find((f) => existsSync(f));
  if (file) process.loadEnvFile(file);
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const app = await buildApp({ config });
  const { host, port } = app.diContainer.cradle.settings.get().server;

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  if (config.configFile) app.log.info({ configFile: config.configFile }, 'loaded config file');
  await app.listen({ host, port });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
