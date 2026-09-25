import { rooms, RUNNER_NAMESPACE, type RunDispatcher } from '@tagconn/shared';
import { aliasTo, asClass } from 'awilix';
import fp from 'fastify-plugin';
import { RunnerGateway } from './runs.gateway.js';
import { RunsRepository } from './runs.repository.js';
import { runsRoutes } from './runs.routes.js';
import { RunsService, type RunLinker } from './runs.service.js';
import { registerRunsSocket } from './runs.socket.js';

export type { RunLinker } from './runs.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    runsRepository: RunsRepository;
    runsService: RunsService;
    runnerGateway: RunnerGateway;
    /** Port `modules/receptionist` (S3) reuses to start/stop its turns without depending on `runsService`. */
    runDispatcher: RunDispatcher;
    /** Port `modules/ingest`/`modules/sessions` (S5) reuse for the `x-tagconn-run-id` hint. */
    runLinker: RunLinker;
  }
}

/**
 * M8 8k runner integration: the `/runner` socket.io namespace (mutual HMAC handshake), the run
 * queue/dispatch/lifecycle, and the quest board (REST `/api/runs*` + socket `runs:*`). See
 * docs/design/runner-and-helpdesk.md §2, §3, §9 (task S2).
 */
export const runsModule = fp(
  async (app) => {
    app.diContainer.register({
      runsRepository: asClass(RunsRepository).singleton(),
      runsService: asClass(RunsService).singleton(),
      runnerGateway: asClass(RunnerGateway).singleton(),
      runDispatcher: aliasTo('runsService'),
      runLinker: aliasTo('runsService'),
    });
    const { cradle } = app.diContainer;

    cradle.runsService.seed();
    cradle.runnerGateway.register(cradle.io.of(RUNNER_NAMESPACE));

    // Admin-only broadcast (docs/design/runner-and-helpdesk.md §5.3: "Admin broadcasts go only to
    // ADMIN_ROOM"), unlike the per-floor broadcasts in core/realtime/index.ts.
    cradle.bus.on('run.upserted', (r) => cradle.office.to(rooms.admin).emit('run:upsert', r));
    cradle.bus.on('run.event', (e) => cradle.office.to(rooms.admin).emit('run:event', e));
    cradle.bus.on('runner.status', (s) => cradle.office.to(rooms.admin).emit('runner:status', s));

    registerRunsSocket(cradle);
    await app.register(runsRoutes);

    app.addHook('onReady', async () => cradle.runsService.start());
    app.addHook('onClose', async () => cradle.runsService.shutdown());
  },
  { name: 'runs', dependencies: ['core-di', 'core-http', 'core-realtime', 'projects', 'heroes'] },
);
