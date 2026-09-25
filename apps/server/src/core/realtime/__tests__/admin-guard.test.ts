import { OFFICE_NAMESPACE, type ClientToServerEvents, type ServerToClientEvents } from '@tagconn/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../../app.js';
import { adminSocketAuth, buildTestApp, mintAdminToken } from '../../../../test/helpers.js';

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

async function listen(app: App): Promise<string> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return `http://127.0.0.1:${address.port}${OFFICE_NAMESPACE}`;
}

function connectClient(base: string, auth?: Record<string, unknown>): ClientSocket {
  return connect(base, { transports: ['websocket'], forceNew: true, auth });
}

async function waitConnected(socket: ClientSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', reject);
  });
}

/** True if the client never got an ack within `ms` (the packet was denied by `socket.use`, which
 * never invokes the underlying handler/ack at all — see core/realtime/admin-guard.ts). */
function emitAndSeeIfAcked(socket: ClientSocket, event: string, payload: unknown, ms = 300): Promise<'acked' | 'timed-out'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timed-out'), ms);
    (socket as unknown as { emit: (ev: string, ...a: unknown[]) => void }).emit(event, payload, () => {
      clearTimeout(timer);
      resolve('acked');
    });
  });
}

describe('admin-guard: socket gating (docs/design/runner-and-helpdesk.md §5.3)', () => {
  let app: App | undefined;
  let sockets: ClientSocket[] = [];
  afterEach(async () => {
    for (const s of sockets) s.disconnect();
    sockets = [];
    await app?.close();
    app = undefined;
  });

  it('an unauthenticated socket stays a read-only observer: public events still work', async () => {
    app = await buildTestApp();
    const socket = connectClient(await listen(app));
    sockets.push(socket);
    await waitConnected(socket);
    const ack = await new Promise<{ ok: boolean }>((resolve) => socket.emit('settings:get', resolve));
    expect(ack.ok).toBe(true);
  });

  it('gates a cosmetic write (settings:update) under protect: all-writes, the default', async () => {
    app = await buildTestApp();
    const socket = connectClient(await listen(app));
    sockets.push(socket);
    await waitConnected(socket);
    const outcome = await emitAndSeeIfAcked(socket, 'settings:update', { office: { zoom: 2 } });
    expect(outcome).toBe('timed-out');
  });

  it('opens the same cosmetic write under protect: execution', async () => {
    app = await buildTestApp({ settings: { auth: { protect: 'execution' } } });
    const socket = connectClient(await listen(app));
    sockets.push(socket);
    await waitConnected(socket);
    const outcome = await emitAndSeeIfAcked(socket, 'settings:update', { office: { zoom: 2 } });
    expect(outcome).toBe('acked');
  });

  it('always gates an event outside both lists, even one added later and never documented', async () => {
    app = await buildTestApp();
    // Stands in for "an event added later and forgotten" (§5.3): wire up a real handler for a name
    // the contract has never heard of, and confirm the guard still denies it before that handler runs.
    app.diContainer.cradle.office.on('connection', (socket) => {
      (socket as unknown as { on: (ev: string, fn: (ack: (v: unknown) => void) => void) => void }).on(
        'totally:unknown:event',
        (ack) => ack({ ok: true, data: 'leaked' }),
      );
    });
    const socket = connectClient(await listen(app));
    sockets.push(socket);
    await waitConnected(socket);
    const outcome = await emitAndSeeIfAcked(socket, 'totally:unknown:event', undefined);
    expect(outcome).toBe('timed-out');
  });

  it('a real always-gated event (auth:sessions) needs a currently-valid admin session', async () => {
    app = await buildTestApp();
    const base = await listen(app);

    const anon = connectClient(base);
    sockets.push(anon);
    await waitConnected(anon);
    expect(await emitAndSeeIfAcked(anon, 'auth:sessions', undefined)).toBe('timed-out');

    const admin = connectClient(base, adminSocketAuth(app));
    sockets.push(admin);
    await waitConnected(admin);
    const ack = await new Promise<{ ok: boolean }>((resolve) => admin.emit('auth:sessions', resolve));
    expect(ack.ok).toBe(true);
  });

  it('a revoked token is refused within the next gated packet, and the socket is swept from ADMIN_ROOM', async () => {
    app = await buildTestApp();
    const base = await listen(app);
    const token = app.diContainer.cradle.authService.createSession('x', 'test').token;
    const admin = connectClient(base, { adminToken: token });
    sockets.push(admin);
    await waitConnected(admin);
    expect((await new Promise<{ ok: boolean }>((resolve) => admin.emit('auth:sessions', resolve))).ok).toBe(true);

    const changed = new Promise<{ admin: boolean }>((resolve) => admin.once('auth:changed', resolve));
    const sessionId = app.diContainer.cradle.authService.verify(token).sessionId!;
    app.diContainer.cradle.authService.revoke(sessionId); // revoke() forces an immediate sweep

    expect((await changed).admin).toBe(false); // swept out of ADMIN_ROOM and told so
    expect(await emitAndSeeIfAcked(admin, 'auth:sessions', undefined)).toBe('timed-out'); // and re-checked per packet too
  });

  it('M1: a truly idle connected socket still expires after sessionIdleHours — the handshake and the periodic sweep never slide the idle expiry', async () => {
    app = await buildTestApp({ settings: { auth: { sessionIdleHours: 1 } } });
    const base = await listen(app);
    const token = mintAdminToken(app); // expiresAt = createdAt + 1h, set only once, at creation
    const admin = connectClient(base, { adminToken: token });
    sockets.push(admin);
    await waitConnected(admin); // the handshake's own ADMIN_ROOM join must not touch the session either

    const changed = new Promise<{ admin: boolean }>((resolve) => admin.once('auth:changed', resolve));
    vi.useFakeTimers({ toFake: ['Date'] }); // real timers keep running the socket; only Date.now() moves
    try {
      // Five sweep intervals pass while the socket stays connected but silent (no gated packet is ever
      // sent, i.e. no real user activity). Before M1, every sweep called the touching `verify()` and
      // would have reset the idle clock each time, so the session would NEVER expire no matter how many
      // sweeps ran. With the fix, `adminChecker.check()` never touches, so once real elapsed time passes
      // sessionIdleHours since creation, the very next sweep evicts it.
      for (let i = 0; i < 5; i++) {
        vi.setSystemTime(Date.now() + 20 * 60 * 1000);
        await app.diContainer.cradle.adminGuard.sweepNow();
      }
    } finally {
      vi.useRealTimers();
    }
    expect((await changed).admin).toBe(false);
    expect(app.diContainer.cradle.authService.verify(token).ok).toBe(false); // actually expired, not just swept
  });
});
