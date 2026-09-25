import { randomUUID } from 'node:crypto';
import {
  HMAC_CONTEXTS,
  proofMessage,
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL_VERSION,
  type RunEnd,
  type RunEventEnvelope,
  type RunnerHello,
  type RunnerHelloAckData,
  type RunStartCommand,
  type RunStopCommand,
} from '@tagconn/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { computeProof, freshNonce } from '../runs.hmac.js';
import type { App } from '../../../app.js';

type RawSocket = Socket;

/** A `runner:hello` with every field filled in; override just what a test cares about. */
export function fakeHello(overrides: Partial<RunnerHello> = {}): RunnerHello {
  return {
    protocol: RUNNER_PROTOCOL_VERSION,
    runnerId: overrides.runnerId ?? randomUUID(),
    version: '0.1.0-test',
    hostname: 'test-host',
    platform: 'linux',
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
      bwrap: true,
      systemdScope: true,
    },
    maxConcurrent: 2,
    maxPermissionMode: 'bypassPermissions',
    allowedProjectDirs: ['/tmp'],
    questMaxAllowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
    receptionistSandbox: 'bwrap',
    receptionistFlags: { restricted: true, safeModeProjectScope: false },
    activeRunIds: [],
    ...overrides,
  };
}

/** Tests may open several fake-runner connections against the same `app`; only listen once. */
const listenUrls = new WeakMap<App, string>();

async function listen(app: App): Promise<string> {
  const cached = listenUrls.get(app);
  if (cached) return cached;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const url = `http://127.0.0.1:${address.port}${RUNNER_NAMESPACE}`;
  listenUrls.set(app, url);
  return url;
}

/** Bare connection (no handshake logic run yet) — for tests that drive the handshake by hand. */
export async function connectRawRunner(app: App, auth: Record<string, unknown>): Promise<RawSocket> {
  const url = await listen(app);
  return connect(url, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
}

export interface FakeRunner {
  socket: RawSocket;
  runnerId: string;
  onStart(handler: (cmd: RunStartCommand, ack: (res: { ok: true; data: { pid: number | null } } | { ok: false; error: string }) => void) => void): void;
  onStop(handler: (cmd: RunStopCommand) => void): void;
  sendEvent(env: RunEventEnvelope): void;
  sendEnd(end: RunEnd): void;
  close(): void;
}

/** Connects and completes the full HMAC handshake + `runner:hello`, using the real token from
 * `settings.runner.token`. Throws if any step is rejected. */
export async function connectVerifiedRunner(
  app: App,
  opts: { token: string; runnerId?: string; hello?: Partial<RunnerHello> } = { token: '' },
): Promise<FakeRunner> {
  const runnerId = opts.runnerId ?? randomUUID();
  const Nr = freshNonce();
  const socket = await connectRawRunner(app, { runnerId, protocol: RUNNER_PROTOCOL_VERSION, nonce: Nr });

  const challenge = await new Promise<{ nonce: string; proof: string }>((resolve, reject) => {
    socket.on('runner:challenge', resolve);
    socket.on('connect_error', reject);
  });

  const runnerProof = computeProof(opts.token, proofMessage(HMAC_CONTEXTS.runner, 'runner', challenge.nonce, Nr));
  const proveAck = await new Promise<{ ok: boolean; error?: string }>((resolve) => socket.emit('runner:prove', { proof: runnerProof }, resolve));
  if (!proveAck.ok) throw new Error(`prove rejected: ${proveAck.error}`);

  const helloAck = await new Promise<{ ok: boolean; data?: RunnerHelloAckData; error?: string }>((resolve) =>
    socket.emit('runner:hello', fakeHello({ runnerId, ...opts.hello }), resolve),
  );
  if (!helloAck.ok) throw new Error(`hello rejected: ${helloAck.error}`);

  return {
    socket,
    runnerId,
    onStart: (handler) => socket.on('run:start', handler),
    onStop: (handler) => socket.on('run:stop', handler),
    sendEvent: (env) => socket.emit('run:event', env),
    sendEnd: (end) => socket.emit('run:end', end),
    close: () => socket.disconnect(),
  };
}
