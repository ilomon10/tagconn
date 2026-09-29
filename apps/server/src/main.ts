import { buildApp } from './app.js';
import { loadConfig, loadDotEnv } from './core/config/index.js';

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
      // Disconnect socket.io clients first: fastify's close would otherwise wait for every open (web socket) connection.
      app.diContainer.cradle.io.engine.close();
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // QA K: the desktop supervisor passes its pid; if it dies (even by SIGKILL) nobody would stop us. ppid changes on
  // POSIX when the parent dies, and signal 0 fails once the pid is gone (the only signal on win32, where ppid is static).
  const parentPid = Number(process.env.TAGCONN_PARENT_PID);
  if (Number.isInteger(parentPid) && parentPid > 1) {
    const startPpid = process.ppid;
    const gone = () => {
      if (process.platform !== 'win32' && process.ppid !== startPpid) return true;
      try {
        process.kill(parentPid, 0);
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ESRCH';
      }
    };
    setInterval(() => {
      if (gone()) void shutdown('parent exited');
    }, 2_000).unref();
  }

  if (config.configFile) app.log.info({ configFile: config.configFile }, 'loaded config file');
  await app.listen({ host, port });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
