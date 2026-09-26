// Integration test against a FAKE /runner SERVER (real `socket.io`, not a mock), driving the actual
// runner client code (socketClient.ts's connectRunner + wireSocket.ts + runManager.ts) through the
// exact protocol described in docs/design/runner-and-helpdesk.md §2.2 and confirmed against the real,
// merged S2 implementation (apps/server/src/modules/runs/runs.gateway.ts):
//  1. connect to `${url}${RUNNER_NAMESPACE}` with auth {runnerId, protocol, nonce}, no Origin header.
//  2. server emits runner:challenge {nonce, proof}; the runner verifies before doing anything else.
//  3. runner emits runner:prove {proof}, acked Ack<true>; anything else before this disconnects.
//  4. runner emits runner:hello, acked Ack<{serverVersion, killRunIds}>; killRunIds are stopped.
//  5. server emits run:start(cmd, ack); runner acks {ok:true,data:{pid}} promptly.
//  6. runner emits run:event / run:end fire-and-forget.
//  7. server emits run:stop({runId, reason}); reason 'timeout' is a normal stop too.

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  DEFAULT_QUEST_ALWAYS_DENY,
  DEFAULT_QUEST_MAX_ALLOWED_TOOLS,
  RUNNER_NAMESPACE,
  RunEndSchema,
  RunEventEnvelopeSchema,
  RunnerHandshakeAuthSchema,
  RunnerHelloSchema,
  type RunEnd,
  type RunEventEnvelope,
  type RunnerHello,
  type RunStartCommand,
  type RunStopCommand,
} from '@tagconn/shared';
import { Server as SocketIOServer, type Namespace, type Socket as ServerSocket } from 'socket.io';
import type { Socket as ClientSocket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfflineQueue, type OfflineQueue } from '../../src/buffer.js';
import { expectedServerProof, runnerProof, verifyProof } from '../../src/hmac.js';
import { loadLedger } from '../../src/ledger.js';
import { createLogger } from '../../src/logger.js';
import { createRunManager, type RunManagerDeps } from '../../src/runManager.js';
import { connectRunner, type RunnerConnection } from '../../src/socketClient.js';
import { announceVerified, wireRunnerSocket } from '../../src/wireSocket.js';
import { FAKE_CLAUDE_BIN_PATH, mkSandbox, rmSandbox } from '../helpers.js';

type AckEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

interface FakeServer {
  url: string;
  seenOrigin: (string | undefined)[];
  helloSeen: RunnerHello[];
  events: RunEventEnvelope[];
  ends: RunEnd[];
  proveAttempts: number;
  waitForSocket(): Promise<ServerSocket>;
  sendStart(cmd: RunStartCommand): Promise<AckEnvelope<{ pid: number | null }>>;
  sendStop(cmd: RunStopCommand): void;
  close(): Promise<void>;
}

interface FakeServerOptions {
  /**
   * R1 (SC5 re-review): for this many of the INITIAL connection attempts, drop the transport (a real
   * network-blip-style close, not a deliberate server-side disconnect) before ever sending
   * `runner:challenge`. Simulates H1(a): a connection dropped before the runner ever saw a challenge.
   */
  dropBeforeChallengeCount?: number;
  /**
   * R1: for this many of the INITIAL connection attempts, after receiving a CORRECT `runner:prove`,
   * drop the transport instead of acking it. Simulates H1(b): a connection dropped after `runner:prove`
   * was sent but before its ack ever reached the runner.
   */
  dropAfterProveCount?: number;
}

/** Starts a real socket.io server on the /runner namespace, implementing the exact S2 protocol
 * (mirrors apps/server/src/modules/runs/runs.gateway.ts). `killRunIds` seeds what the FIRST
 * runner:hello is acked with. */
function startFakeServer(token: string, killRunIds: string[] = [], opts: FakeServerOptions = {}): Promise<FakeServer> {
  return new Promise((resolve) => {
    const httpServer: HttpServer = createServer();
    const io = new SocketIOServer(httpServer, {});
    const ns: Namespace = io.of(RUNNER_NAMESPACE);

    const seenOrigin: (string | undefined)[] = [];
    const helloSeen: RunnerHello[] = [];
    const events: RunEventEnvelope[] = [];
    const ends: RunEnd[] = [];
    let proveAttempts = 0;
    let connectionAttempts = 0;
    let resolveSocket: ((s: ServerSocket) => void) | undefined;
    let currentSocket: ServerSocket | undefined;
    const socketPromise = new Promise<ServerSocket>((r) => {
      resolveSocket = r;
    });

    ns.use((socket, next) => {
      seenOrigin.push(socket.handshake.headers.origin);
      if (socket.handshake.headers.origin) {
        next(new Error('runner connections must not carry an Origin header'));
        return;
      }
      const parsed = RunnerHandshakeAuthSchema.safeParse(socket.handshake.auth);
      if (!parsed.success) {
        next(new Error('invalid runner handshake'));
        return;
      }
      socket.data.auth = parsed.data;
      socket.data.verified = false;
      next();
    });

    ns.on('connection', (socket: ServerSocket) => {
      connectionAttempts += 1;
      const attempt = connectionAttempts;
      const auth = socket.data.auth as { runnerId: string; nonce: string };

      if (opts.dropBeforeChallengeCount && attempt <= opts.dropBeforeChallengeCount) {
        // R1(a): a network-level drop (NOT socket.disconnect(true), which the client would treat as
        // deliberate) before runner:challenge is ever sent.
        socket.conn.close();
        return;
      }

      const Ns = randomBytes(32).toString('base64url');
      socket.emit('runner:challenge', { nonce: Ns, proof: expectedServerProof(token, auth.nonce, Ns) });

      // §2.2 step 4: nothing but 'runner:prove' is processed before verification.
      socket.use(([event], next) => {
        if (!socket.data.verified && event !== 'runner:prove') {
          socket.disconnect(true);
          return;
        }
        next();
      });

      socket.on('runner:prove', (p: { proof: string }, ack: (res: AckEnvelope<true>) => void) => {
        proveAttempts += 1;
        const expected = runnerProof(token, Ns, auth.nonce);
        if (!verifyProof(expected, p.proof)) {
          ack({ ok: false, error: 'server proof invalid: wrong token' });
          setImmediate(() => socket.disconnect(true));
          return;
        }
        if (opts.dropAfterProveCount && attempt <= opts.dropAfterProveCount) {
          // R1(b): the proof WAS correct, but the ack never reaches the runner (network drop).
          socket.conn.close();
          return;
        }
        socket.data.verified = true;
        ack({ ok: true, data: true });
      });

      socket.on('runner:hello', (hello: unknown, ack: (res: AckEnvelope<{ serverVersion: string; killRunIds: string[] }>) => void) => {
        const parsed = RunnerHelloSchema.safeParse(hello);
        if (!parsed.success || parsed.data.runnerId !== auth.runnerId) {
          ack({ ok: false, error: 'invalid runner:hello' });
          setImmediate(() => socket.disconnect(true));
          return;
        }
        helloSeen.push(parsed.data);
        currentSocket = socket;
        resolveSocket?.(socket);
        ack({ ok: true, data: { serverVersion: 'test-server', killRunIds } });
      });

      socket.on('run:event', (env: unknown) => {
        const parsed = RunEventEnvelopeSchema.safeParse(env);
        if (parsed.success) events.push(parsed.data);
      });
      socket.on('run:end', (end: unknown) => {
        const parsed = RunEndSchema.safeParse(end);
        if (parsed.success) ends.push(parsed.data);
      });
    });

    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seenOrigin,
        helloSeen,
        events,
        ends,
        get proveAttempts() {
          return proveAttempts;
        },
        waitForSocket: () => socketPromise,
        sendStart: (cmd) =>
          new Promise((r) => {
            currentSocket!.timeout(5000).emit('run:start', cmd, (err: unknown, res: AckEnvelope<{ pid: number | null }>) => {
              r(err ? { ok: false, error: 'ack timeout' } : res);
            });
          }),
        sendStop: (cmd) => currentSocket!.emit('run:stop', cmd),
        close: () =>
          new Promise<void>((r) => {
            io.close();
            httpServer.close(() => r());
          }),
      });
    });
  });
}

const TOKEN = 'e'.repeat(32);

/**
 * Real `emitEvent`/`emitEnd`, mirroring main.ts's H1/L5 routing EXACTLY: only ever emit straight onto
 * the live socket when THIS process itself verified it and it is still connected; otherwise queue
 * (never silently drop). Recording is done server-side via FakeServer instead of locally, since the
 * point is to prove the events actually cross the wire (or get replayed after a reconnect).
 */
function makeRunManagerDeps(stateDir: string, getConnection: () => RunnerConnection, offlineQueue: OfflineQueue, passEnv: string[] = []): RunManagerDeps {
  return {
    cfg: {
      configPath: join(stateDir, 'runner.json'),
      url: 'http://127.0.0.1:0',
      token: TOKEN,
      runnerId: randomUUID(),
      allowedProjectDirs: [stateDir],
      trustOverrideDirs: [stateDir],
      questToolPolicy: { maxAllowedTools: [...DEFAULT_QUEST_MAX_ALLOWED_TOOLS], alwaysDeny: [...DEFAULT_QUEST_ALWAYS_DENY] },
      maxConcurrent: 2,
      maxPermissionMode: 'acceptEdits',
      allowBypassPermissions: false,
      passEnv,
      claudePath: FAKE_CLAUDE_BIN_PATH,
      stateDir,
      receptionistSandbox: 'none',
      processIsolation: 'none',
      memoryMax: '4G',
      tasksMax: 512,
      maxLineBytes: 1024 * 1024,
      maxStderrLines: 200,
      killGraceMs: 2000,
      offlineBufferEvents: 100,
      offlineBufferBytes: 1_000_000,
      sessionLedgerSize: 100,
      questTimeoutCapSec: 3_600,
      receptionistTimeoutCapSec: 300,
    },
    caps: {
      stdinPrompt: true,
      includePartialMessages: true,
      settingSources: true,
      strictMcpConfig: true,
      tools: true,
      permissionPrompts: true,
      disableSlashCommands: true,
      restricted: true,
      safeMode: true,
      permissionModes: ['plan', 'dontAsk', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
      bwrap: false,
      systemdScope: false,
    },
    ledger: loadLedger(join(stateDir, 'session-ledger.json')),
    ledgerPath: join(stateDir, 'session-ledger.json'),
    claudeJsonPath: join(stateDir, '.claude.json'),
    logger: createLogger('error'),
    emitEvent: (env) => {
      const c = getConnection();
      if (c.isVerified() && c.socket.connected) c.socket.emit('run:event', env);
      else offlineQueue.pushEvent(env);
    },
    emitEnd: (end) => {
      const c = getConnection();
      if (c.isVerified() && c.socket.connected) c.socket.emit('run:end', end);
      else offlineQueue.pushEnd(end);
    },
  };
}

function baseQuestCmd(projectDir: string, overrides: Partial<RunStartCommand> = {}): RunStartCommand {
  return {
    runId: randomUUID(),
    kind: 'quest',
    projectDir,
    prompt: 'reply with the single word ok',
    permissionMode: 'acceptEdits',
    model: 'sonnet',
    allowedTools: ['Read'],
    disallowedTools: [],
    timeoutSec: 60,
    readOnly: false,
    addTagconnDocs: false,
    allowWebSearch: true,
    webFetchDomains: [],
    safeMode: false,
    partialMessages: true,
    limits: { maxEvents: 1000, maxEventBytes: 1_000_000, previewChars: 2000 },
    ...overrides,
  };
}

/**
 * Wires up connectRunner() + wireRunnerSocket() against `server`, exactly the way main.ts does (H1):
 * wireRunnerSocket is called ONCE, immediately, gated on `connection.isVerified()`; announceVerified
 * (runner:hello + offline replay) runs again on every successful (re)verification.
 */
function connectAndWire(server: FakeServer, stateDir: string, passEnv: string[] = []) {
  const offlineQueue = createOfflineQueue(100, 1_000_000);
  const deps = makeRunManagerDeps(stateDir, () => connection, offlineQueue, passEnv);
  const runManager = createRunManager(deps);
  const runnerId = deps.cfg.runnerId!;
  const wireDeps = { runManager, offlineQueue, cfg: deps.cfg, hello: fakeHello(runnerId), logger: deps.logger };

  const connection: RunnerConnection = connectRunner({
    url: server.url,
    token: TOKEN,
    runnerId,
    onVerified: () => announceVerified(connection.socket, wireDeps),
  });
  wireRunnerSocket(connection.socket, { ...wireDeps, isVerified: connection.isVerified });

  return { socket: connection.socket, connection, runManager, deps, runnerId, offlineQueue };
}

describe('runner <-> fake /runner server protocol', () => {
  const sandboxes: string[] = [];
  let server: FakeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  it('completes the full handshake with no Origin header and a fresh nonce per connection', async () => {
    server = await startFakeServer(TOKEN);
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const { socket, runnerId } = connectAndWire(server, stateDir);

    const serverSocket = await server.waitForSocket();
    expect(serverSocket).toBeDefined();
    expect(server.seenOrigin.every((o) => o === undefined)).toBe(true);
    expect(server.helloSeen).toHaveLength(1);
    expect(server.helloSeen[0]?.runnerId).toBe(runnerId);
    expect(server.proveAttempts).toBe(1);
    socket.disconnect();
  });

  it('never sends runner:prove (or any other event) if the server proof is wrong, and disconnects', async () => {
    // A server that computes the challenge proof with the WRONG token: the runner must verify and
    // refuse before ever sending runner:prove.
    server = await startFakeServer(`${TOKEN.slice(0, -1)}f`); // different token -> wrong proof
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const { socket } = connectAndWire(server, stateDir);
    socket.io.reconnection(false); // one attempt is enough to prove the point

    await new Promise((r) => setTimeout(r, 500));
    expect(server.proveAttempts).toBe(0); // never even sent runner:prove
    expect(server.helloSeen).toHaveLength(0);
    socket.disconnect();
  });

  it('run:start acks {ok:true,data:{pid}} promptly, then run:event/run:end arrive fire-and-forget', async () => {
    server = await startFakeServer(TOKEN);
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const { socket } = connectAndWire(server, stateDir);
    await server.waitForSocket();

    const ack = await server.sendStart(baseQuestCmd(stateDir));
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(typeof ack.data.pid === 'number').toBe(true); // the fake CLI actually spawns

    // Wait for the fake CLI to finish and the run to end.
    for (let i = 0; i < 50 && server.ends.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(server.ends).toHaveLength(1);
    expect(server.ends[0]?.status).toBe('succeeded');
    expect(server.events.some((e) => e.event.kind === 'init')).toBe(true);
    expect(server.events.some((e) => e.event.kind === 'result')).toBe(true);
    socket.disconnect();
  }, 10_000);

  it('a policy-refused run:start still acks {ok:true,data:{pid:null}} (never {ok:false} for an ordinary refusal)', async () => {
    server = await startFakeServer(TOKEN);
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const { socket } = connectAndWire(server, stateDir);
    await server.waitForSocket();

    // Bash is not in the default questToolPolicy.maxAllowedTools -> tool_not_allowed.
    const ack = await server.sendStart(baseQuestCmd(stateDir, { allowedTools: ['Bash'] }));
    expect(ack).toEqual({ ok: true, data: { pid: null } });

    for (let i = 0; i < 20 && server.ends.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(server.ends[0]?.status).toBe('rejected');
    expect(server.ends[0]?.reason).toBe('tool_not_allowed');
    socket.disconnect();
  });

  it('run:stop mid-run ends the run with status "stopped" and the given reason (including "timeout")', async () => {
    server = await startFakeServer(TOKEN);
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    // FAKE_CLAUDE_SLEEP_MS makes the fake CLI keep running after it prints its normal output, so
    // there's time to send run:stop before it would exit on its own. It must be in passEnv, since
    // buildRunEnv (src/env.ts) strips anything not in the base allowlist / LC_*/XDG_* / passEnv.
    const { socket } = connectAndWire(server, stateDir, ['FAKE_CLAUDE_SLEEP_MS']);
    await server.waitForSocket();

    const cmd = baseQuestCmd(stateDir);
    process.env.FAKE_CLAUDE_SLEEP_MS = '10000';
    try {
      const ack = await server.sendStart(cmd);
      expect(ack.ok).toBe(true);

      // Give the fake CLI a moment to print its init/text/result lines before it blocks in "sleep".
      await new Promise((r) => setTimeout(r, 300));

      // The server sends reason "timeout" when its own event caps trip; the runner must treat it as a
      // normal stop, not a failure.
      server.sendStop({ runId: cmd.runId, reason: 'timeout' });

      for (let i = 0; i < 50 && server.ends.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      expect(server.ends).toHaveLength(1);
      expect(server.ends[0]?.status).toBe('timeout');
      expect(server.ends[0]?.reason).toBe('timeout');
    } finally {
      delete process.env.FAKE_CLAUDE_SLEEP_MS;
    }
    socket.disconnect();
  }, 10_000);

  it('runner:hello ack killRunIds are stopped by the runner', async () => {
    const runId = randomUUID();
    server = await startFakeServer(TOKEN, [runId]);
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const { socket, runManager } = connectAndWire(server, stateDir);
    const stoppedIds: string[] = [];
    const originalStop = runManager.stop.bind(runManager);
    (runManager as { stop: typeof runManager.stop }).stop = (cmd) => {
      stoppedIds.push(cmd.runId);
      originalStop(cmd);
    };

    await server.waitForSocket();
    await new Promise((r) => setTimeout(r, 100));
    expect(stoppedIds).toEqual([runId]);
    socket.disconnect();
  });

  // ---------------------------------------------------------------------------------------- H1 (SC5)

  it('H1 regression: reconnecting to the SAME server does not duplicate command handlers (one run:start -> exactly one spawn)', async () => {
    server = await startFakeServer(TOKEN);
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const { socket, runManager } = connectAndWire(server, stateDir);

    const firstServerSocket = await server.waitForSocket();
    expect(server.helloSeen).toHaveLength(1);

    let startCalls = 0;
    const originalStartQuest = runManager.startQuest.bind(runManager);
    (runManager as { startQuest: typeof runManager.startQuest }).startQuest = (cmd) => {
      startCalls += 1;
      return originalStartQuest(cmd);
    };

    // Force a transport-level disconnect (NOT socket.disconnect(true): socket.io-client treats an
    // explicit server-side disconnect as deliberate and does not auto-reconnect from it). Closing the
    // underlying engine.io connection instead simulates a real network blip, which DOES trigger
    // socket.io-client's automatic reconnect — redoing the full mutual-HMAC handshake on the SAME
    // client Socket object. This is exactly the situation H1 flagged: with the old code,
    // wireRunnerSocket was called again from inside onSocket per connection, so 'run:start' would end
    // up with two listeners on the one Socket.
    firstServerSocket.conn.close();
    for (let i = 0; i < 100 && server.helloSeen.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(server.helloSeen.length).toBeGreaterThanOrEqual(2);

    const ack = await server.sendStart(baseQuestCmd(stateDir));
    expect(ack.ok).toBe(true);
    for (let i = 0; i < 50 && server.ends.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(startCalls).toBe(1); // NOT 2: the handler must not have been registered twice
    socket.disconnect();
  }, 15_000);

  it('H1 regression: a server that never completes the handshake (sends run:start straight away) never triggers a spawn', async () => {
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const httpServer: HttpServer = createServer();
    const io = new SocketIOServer(httpServer, {});
    const ns: Namespace = io.of(RUNNER_NAMESPACE);
    ns.on('connection', (sock) => {
      // Impersonator: never sends 'runner:challenge' at all, goes straight for the payoff.
      sock.emit('run:start', baseQuestCmd(stateDir), () => {
        /* the runner must never call this ack in the first place */
      });
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const { port } = httpServer.address() as AddressInfo;

    const offlineQueue = createOfflineQueue(100, 1_000_000);
    let connection!: RunnerConnection;
    const deps = makeRunManagerDeps(stateDir, () => connection, offlineQueue);
    const runManager = createRunManager(deps);
    let startCalls = 0;
    const originalStartQuest = runManager.startQuest.bind(runManager);
    (runManager as { startQuest: typeof runManager.startQuest }).startQuest = (cmd) => {
      startCalls += 1;
      return originalStartQuest(cmd);
    };
    const wireDeps = { runManager, offlineQueue, cfg: deps.cfg, hello: fakeHello(deps.cfg.runnerId!), logger: deps.logger };

    connection = connectRunner({
      url: `http://127.0.0.1:${port}`,
      token: TOKEN,
      runnerId: deps.cfg.runnerId!,
      onVerified: () => announceVerified(connection.socket, wireDeps),
    });
    connection.socket.io.reconnection(false);
    wireRunnerSocket(connection.socket, { ...wireDeps, isVerified: connection.isVerified });

    await new Promise((r) => setTimeout(r, 400));
    expect(connection.isVerified()).toBe(false);
    expect(startCalls).toBe(0);

    connection.socket.disconnect();
    await new Promise<void>((resolve) => {
      io.close();
      httpServer.close(() => resolve());
    });
  });

  // ---------------------------------------------------------------------------------------- R1 (SC5 re-review)
  //
  // The H1 fix (above) stopped a reused Socket's stale command-handler registrations from double-firing,
  // but left the runner able to go PERMANENTLY offline: a connection dropped mid-handshake left its
  // handshake's own listeners registered, and any verified:false outcome (including one settling AFTER
  // the drop) called a MANUAL socket.disconnect() — which stops socket.io-client's own reconnection for
  // good (systemd Restart=on-failure never even fires, since the process keeps running, just
  // disconnected). These regression tests drive that against a REAL socket.io server.

  it('R1 regression: a connection dropped before runner:challenge arrives still recovers and verifies on the next connection', async () => {
    server = await startFakeServer(TOKEN, [], { dropBeforeChallengeCount: 1 });
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const { socket, connection } = connectAndWire(server, stateDir);

    await server.waitForSocket();
    expect(connection.isVerified()).toBe(true);
    expect(server.helloSeen).toHaveLength(1);
    // The first (dropped) attempt never got far enough to send runner:prove at all.
    expect(server.proveAttempts).toBe(1);
    socket.disconnect();
  }, 10_000);

  it('R1 regression: a connection dropped after runner:prove (before its ack) still recovers and verifies on the next connection', async () => {
    server = await startFakeServer(TOKEN, [], { dropAfterProveCount: 1 });
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const { socket, connection } = connectAndWire(server, stateDir);

    await server.waitForSocket();
    expect(connection.isVerified()).toBe(true);
    expect(server.helloSeen).toHaveLength(1);
    // First attempt: correct proof, verified server-side, but the ack was dropped. Second: succeeds.
    expect(server.proveAttempts).toBe(2);
    socket.disconnect();
  }, 10_000);

  it('R1 regression: a persistently bad-proof server never gets verified, across several real reconnects, and never wedges the client', async () => {
    server = await startFakeServer(`${TOKEN.slice(0, -1)}f`); // wrong token -> every challenge proof is wrong
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const { socket, connection } = connectAndWire(server, stateDir); // reconnection left enabled (the default)

    // Give it several real reconnect/backoff cycles (default reconnectionDelay 1s, randomized).
    await new Promise((r) => setTimeout(r, 4_000));
    expect(connection.isVerified()).toBe(false);
    expect(server.helloSeen).toHaveLength(0);
    expect(server.proveAttempts).toBe(0); // a bad server proof must never even be proved against
    socket.disconnect();
  }, 10_000);
});

function fakeHello(runnerId: string): RunnerHello {
  return {
    protocol: 1,
    runnerId,
    version: '0.3.0-test',
    hostname: 'test-host',
    platform: 'linux',
    claudeVersion: '2.1.282',
    capabilities: {
      stdinPrompt: true,
      includePartialMessages: true,
      settingSources: true,
      strictMcpConfig: true,
      tools: true,
      permissionPrompts: true,
      disableSlashCommands: true,
      restricted: true,
      safeMode: true,
      permissionModes: ['plan', 'dontAsk', 'default', 'acceptEdits', 'auto', 'bypassPermissions'],
      bwrap: false,
      systemdScope: false,
    },
    maxConcurrent: 2,
    maxPermissionMode: 'acceptEdits',
    allowedProjectDirs: [],
    questMaxAllowedTools: [...DEFAULT_QUEST_MAX_ALLOWED_TOOLS],
    receptionistSandbox: 'none',
    receptionistFlags: { restricted: true, safeModeProjectScope: false },
    activeRunIds: [],
  };
}
