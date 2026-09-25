import {
  HMAC_CONTEXTS,
  proofMessage,
  RUNNER_NAMESPACE,
  RUNNER_PROOF_TIMEOUT_MS,
  RunEndSchema,
  RunEventEnvelopeSchema,
  type RunnerHandshakeAuth,
  RunnerHandshakeAuthSchema,
  type RunnerHelloAckData,
  RunnerHelloSchema,
  RunnerProveSchema,
  type RunnerToServerEvents,
  type ServerToRunnerEvents,
} from '@tagconn/shared';
import type { DefaultEventsMap, Namespace, Socket } from 'socket.io';
import pkg from '../../../package.json';
import type { Deps } from '../../core/di/index.js';
import { computeProof, freshNonce, verifyProof } from './runs.hmac.js';
import type { RunnerConnection, RunsService } from './runs.service.js';

/** socket.io v4 ack timeout for `run:start`: the runner spawns synchronously enough that a real
 * reply should arrive well under this; past it we treat the dispatch as failed (defense in depth
 * against a wedged runner process, not a normal path). */
const RUN_START_ACK_TIMEOUT_MS = 15_000;

/** L8: caps sockets that have connected but not yet completed the HMAC proof (§2.2 steps 1-4). Without
 * this, a slowloris-style flood of connections that never send `runner:prove` could pile up unbounded
 * (each held open for up to RUNNER_PROOF_TIMEOUT_MS). */
const MAX_UNVERIFIED_RUNNER_SOCKETS = 8;

interface RunnerSocketData {
  auth: RunnerHandshakeAuth;
  verified: boolean;
}

type RunnerNamespace = Namespace<RunnerToServerEvents, ServerToRunnerEvents, DefaultEventsMap, RunnerSocketData>;
type RunnerSocket = Socket<RunnerToServerEvents, ServerToRunnerEvents, DefaultEventsMap, RunnerSocketData>;

/**
 * `/runner` socket.io namespace: the mutual HMAC challenge-response handshake
 * (docs/design/runner-and-helpdesk.md §2.2, `packages/shared/src/auth.ts`), then run dispatch and
 * event/end ingest. At most one runner is "the" connected runner at a time; a newer verified
 * connection (same or different `runnerId`) replaces the older one.
 */
export class RunnerGateway {
  private currentSocket?: RunnerSocket;
  /** L8: sockets connected but not yet past `runner:prove`. */
  private unverifiedCount = 0;

  constructor(private readonly deps: Deps<'settings' | 'logger'> & { runsService: RunsService }) {}

  /** `raw` is the plain `io.of(RUNNER_NAMESPACE)` Namespace (typed for the `/office` events on the
   * shared `Server` instance); this is the one place that re-types it for the runner protocol. */
  register(raw: unknown): void {
    const ns = raw as RunnerNamespace;

    ns.use((socket, next) => {
      const { token, enabled } = this.deps.settings.get().runner;
      if (!enabled) return next(new Error('runner connections are refused: settings.runner.enabled is false'));
      if (!token) return next(new Error('runner connections are refused: settings.runner.token is empty'));
      if (socket.handshake.headers.origin) return next(new Error('runner connections must not carry an Origin header'));
      const parsed = RunnerHandshakeAuthSchema.safeParse(socket.handshake.auth);
      if (!parsed.success) return next(new Error('invalid runner handshake'));
      if (this.unverifiedCount >= MAX_UNVERIFIED_RUNNER_SOCKETS) {
        return next(new Error('too many unverified runner connections; try again shortly'));
      }
      socket.data.auth = parsed.data;
      socket.data.verified = false;
      next();
    });

    ns.on('connection', (socket) => {
      // H1: a listener that throws crashes the whole process (socket.io calls listeners synchronously
      // and nothing upstream catches it). Nothing runner-controlled — a garbage payload, a missing ack,
      // a mid-handler exception — may ever escape a listener; every path here disconnects instead.
      try {
        this.handleConnection(socket);
      } catch (err) {
        this.deps.logger.error({ err }, 'runner connection handler failed; disconnecting');
        socket.disconnect(true);
      }
    });
  }

  /** H1 safe-ack helper: an ack-taking event sent without a callback function must never throw
   * (`ack is not a function`) — it disconnects the offending socket instead. */
  private static requireAck(ack: unknown, socket: RunnerSocket): ack is (res: unknown) => void {
    if (typeof ack === 'function') return true;
    socket.disconnect(true);
    return false;
  }

  private handleConnection(socket: RunnerSocket): void {
    const auth = socket.data.auth;
    this.unverifiedCount++;
    let stillUnverified = true;
    const releaseUnverifiedSlot = () => {
      if (!stillUnverified) return;
      stillUnverified = false;
      this.unverifiedCount--;
    };

    const token = this.deps.settings.get().runner.token;
    const Ns = freshNonce();
    const serverProof = computeProof(token, proofMessage(HMAC_CONTEXTS.runner, 'server', auth.nonce, Ns));
    socket.emit('runner:challenge', { nonce: Ns, proof: serverProof });

    const proveTimer = setTimeout(() => {
      if (!socket.data.verified) {
        this.deps.logger.warn({ runnerId: auth.runnerId }, 'runner did not prove possession of the token in time');
        socket.disconnect(true);
      }
    }, RUNNER_PROOF_TIMEOUT_MS);
    proveTimer.unref?.();

    // §2.2 step 4: nothing but 'runner:prove' is processed before verification; any other event,
    // including a stray retry, disconnects the socket outright.
    socket.use(([event], next) => {
      try {
        if (!socket.data.verified && event !== 'runner:prove') {
          socket.disconnect(true);
          return;
        }
        next();
      } catch (err) {
        this.deps.logger.error({ err, event }, 'runner packet guard failed; disconnecting');
        socket.disconnect(true);
      }
    });

    socket.on('runner:prove', (p, ack) => {
      if (!RunnerGateway.requireAck(ack, socket)) return;
      try {
        if (socket.data.verified) return;
        const parsed = RunnerProveSchema.safeParse(p);
        const currentToken = this.deps.settings.get().runner.token;
        const expected = proofMessage(HMAC_CONTEXTS.runner, 'runner', Ns, auth.nonce);
        if (!parsed.success || !currentToken || !verifyProof(currentToken, expected, parsed.data.proof)) {
          ack({ ok: false, error: 'server proof invalid: wrong token' });
          // Deferred so the ack packet actually reaches the client before the transport closes.
          setImmediate(() => socket.disconnect(true));
          return;
        }
        clearTimeout(proveTimer);
        socket.data.verified = true;
        releaseUnverifiedSlot();
        ack({ ok: true, data: true });
      } catch (err) {
        this.deps.logger.error({ err }, 'runner:prove handler failed; disconnecting');
        socket.disconnect(true);
      }
    });

    socket.on('runner:hello', (hello, ack) => {
      if (!RunnerGateway.requireAck(ack, socket)) return;
      try {
        this.handleHello(socket, auth, hello, ack as (res: { ok: true; data: RunnerHelloAckData } | { ok: false; error: string }) => void);
      } catch (err) {
        this.deps.logger.error({ err }, 'runner:hello handler failed; disconnecting');
        socket.disconnect(true);
      }
    });

    socket.on('run:event', (env) => {
      try {
        const parsed = RunEventEnvelopeSchema.safeParse(env);
        if (!parsed.success) return;
        this.deps.runsService.onRunEvent(auth.runnerId, parsed.data);
      } catch (err) {
        this.deps.logger.error({ err }, 'run:event handler failed; disconnecting');
        socket.disconnect(true);
      }
    });

    socket.on('run:end', (end) => {
      try {
        const parsed = RunEndSchema.safeParse(end);
        if (!parsed.success) return;
        this.deps.runsService.onRunEnd(auth.runnerId, parsed.data);
      } catch (err) {
        this.deps.logger.error({ err }, 'run:end handler failed; disconnecting');
        socket.disconnect(true);
      }
    });

    socket.on('disconnect', () => {
      releaseUnverifiedSlot();
      clearTimeout(proveTimer);
      if (this.currentSocket === socket) {
        this.currentSocket = undefined;
        this.deps.runsService.runnerDisconnected(auth.runnerId);
      }
    });
  }

  private handleHello(
    socket: RunnerSocket,
    auth: RunnerHandshakeAuth,
    hello: unknown,
    ack: (res: { ok: true; data: RunnerHelloAckData } | { ok: false; error: string }) => void,
  ): void {
    const parsed = RunnerHelloSchema.safeParse(hello);
    if (!parsed.success || parsed.data.runnerId !== auth.runnerId) {
      ack({ ok: false, error: 'invalid runner:hello' });
      setImmediate(() => socket.disconnect(true));
      return;
    }
    if (this.currentSocket && this.currentSocket !== socket) this.currentSocket.disconnect(true);
    this.currentSocket = socket;

    const connection: RunnerConnection = {
      runnerId: parsed.data.runnerId,
      hello: parsed.data,
      sendStart: (cmd, cb) => {
        socket.timeout(RUN_START_ACK_TIMEOUT_MS).emit('run:start', cmd, (err, res) => {
          if (err) return cb({ ok: false, error: 'runner did not acknowledge run:start in time' });
          cb(res);
        });
      },
      sendStop: (cmd) => socket.emit('run:stop', cmd),
    };
    const { killRunIds } = this.deps.runsService.runnerConnected(connection);
    ack({ ok: true, data: { serverVersion: pkg.version, killRunIds } });
  }
}

export { RUNNER_NAMESPACE };
