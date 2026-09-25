import { randomUUID } from 'node:crypto';
import { HMAC_CONTEXTS, proofMessage, RUNNER_PROTOCOL_VERSION } from '@tagconn/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp } from '../../../../test/helpers.js';
import { computeProof, freshNonce, verifyProof } from '../runs.hmac.js';
import { connectRawRunner, connectVerifiedRunner, fakeHello } from './fake-runner.js';

const TOKEN = 'a'.repeat(40);

describe('runs: /runner HMAC handshake (docs/design/runner-and-helpdesk.md §2.2)', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('computeProof/verifyProof: a proof only verifies for the exact (token, message) pair', () => {
    const m1 = proofMessage(HMAC_CONTEXTS.runner, 'server', 'Nr', 'Ns');
    const proof = computeProof(TOKEN, m1);
    expect(verifyProof(TOKEN, m1, proof)).toBe(true);
    expect(verifyProof('a different token', m1, proof)).toBe(false);
    expect(verifyProof(TOKEN, proofMessage(HMAC_CONTEXTS.runner, 'server', 'Nr', 'other-Ns'), proof)).toBe(false);
  });

  it('good handshake: prove and hello both succeed and the runner ends up connected+verified', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true } } });
    const runner = await connectVerifiedRunner(app, { token: TOKEN });
    const status = app.diContainer.cradle.runsService.getRunnerStatus();
    expect(status).toMatchObject({ connected: true, verified: true, runnerId: runner.runnerId });
    runner.close();
  });

  it('a fake runner client can detect an impersonating/squatter server: the challenge proof only matches the real token', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true } } });
    const runnerId = randomUUID();
    const Nr = freshNonce();
    const socket = await connectRawRunner(app, { runnerId, protocol: RUNNER_PROTOCOL_VERSION, nonce: Nr });
    const challenge = await new Promise<{ nonce: string; proof: string }>((resolve) => socket.on('runner:challenge', resolve));

    // The real server used TOKEN; a client that (wrongly) expects a different token computes a
    // different expected proof and must refuse to trust this "server" (§2.2 step 3).
    const expectedWithWrongToken = computeProof('not-the-real-token', proofMessage(HMAC_CONTEXTS.runner, 'server', Nr, challenge.nonce));
    expect(expectedWithWrongToken).not.toBe(challenge.proof);
    // ...but with the real token, it matches (this is what lets a genuine runner trust the server).
    const expectedWithRealToken = computeProof(TOKEN, proofMessage(HMAC_CONTEXTS.runner, 'server', Nr, challenge.nonce));
    expect(expectedWithRealToken).toBe(challenge.proof);
    socket.disconnect();
  });

  it('bad runner proof (wrong token): the server rejects the ack and disconnects', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true } } });
    const Nr = freshNonce();
    const socket = await connectRawRunner(app, { runnerId: randomUUID(), protocol: RUNNER_PROTOCOL_VERSION, nonce: Nr });
    const challenge = await new Promise<{ nonce: string; proof: string }>((resolve) => socket.on('runner:challenge', resolve));

    const wrongProof = computeProof('wrong-token', proofMessage(HMAC_CONTEXTS.runner, 'runner', challenge.nonce, Nr));
    // Registered before emitting: the server's ack and its deferred disconnect can arrive close
    // enough together that a listener added only after awaiting the ack could miss the event.
    const disconnected = new Promise<void>((resolve) => socket.on('disconnect', () => resolve()));
    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => socket.emit('runner:prove', { proof: wrongProof }, resolve));
    expect(ack.ok).toBe(false);
    await disconnected;
  });

  it('replay: a proof computed for an earlier connection\'s nonces is rejected on a fresh connection', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true } } });
    const runnerId = randomUUID();

    // First (legitimate) connection: capture its Nr and the server's Ns.
    const Nr1 = freshNonce();
    const socket1 = await connectRawRunner(app, { runnerId, protocol: RUNNER_PROTOCOL_VERSION, nonce: Nr1 });
    const challenge1 = await new Promise<{ nonce: string; proof: string }>((resolve) => socket1.on('runner:challenge', resolve));
    const proof1 = computeProof(TOKEN, proofMessage(HMAC_CONTEXTS.runner, 'runner', challenge1.nonce, Nr1));
    socket1.disconnect();

    // A new connection gets a fresh Ns; replaying the old proof (bound to the old Ns) must fail.
    const socket2 = await connectRawRunner(app, { runnerId, protocol: RUNNER_PROTOCOL_VERSION, nonce: Nr1 });
    const challenge2 = await new Promise<{ nonce: string; proof: string }>((resolve) => socket2.on('runner:challenge', resolve));
    expect(challenge2.nonce).not.toBe(challenge1.nonce); // fresh Ns each connection
    const ack = await new Promise<{ ok: boolean }>((resolve) => socket2.emit('runner:prove', { proof: proof1 }, resolve));
    expect(ack.ok).toBe(false);
    socket2.disconnect();
  });

  it('empty settings.runner.token refuses every runner connection', async () => {
    app = await buildTestApp({ settings: { runner: { token: '' } } });
    const socket = await connectRawRunner(app, { runnerId: randomUUID(), protocol: RUNNER_PROTOCOL_VERSION, nonce: freshNonce() });
    await new Promise<void>((resolve, reject) => {
      socket.on('connect_error', () => resolve());
      socket.on('connect', () => reject(new Error('should not have connected')));
    });
  });

  it('nothing but runner:prove is processed before verification: any other event disconnects the socket', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true } } });
    const socket = await connectRawRunner(app, { runnerId: randomUUID(), protocol: RUNNER_PROTOCOL_VERSION, nonce: freshNonce() });
    await new Promise<void>((resolve) => socket.on('runner:challenge', () => resolve()));

    const disconnected = new Promise<void>((resolve) => socket.on('disconnect', () => resolve()));
    socket.emit('runner:hello', fakeHello({}), () => {});
    await disconnected;
  });

  it('L8: caps concurrent unverified /runner sockets — the (N+1)th connection attempt is refused until a slot frees up', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true } } });
    const MAX_UNVERIFIED = 8; // matches runs.gateway.ts's MAX_UNVERIFIED_RUNNER_SOCKETS
    const unverified: Awaited<ReturnType<typeof connectRawRunner>>[] = [];
    for (let i = 0; i < MAX_UNVERIFIED; i++) {
      const s = await connectRawRunner(app, { runnerId: randomUUID(), protocol: RUNNER_PROTOCOL_VERSION, nonce: freshNonce() });
      await new Promise<void>((resolve) => s.on('runner:challenge', () => resolve()));
      unverified.push(s);
    }

    // The (N+1)th connection is refused outright — never even gets a challenge.
    const overflow = await connectRawRunner(app, { runnerId: randomUUID(), protocol: RUNNER_PROTOCOL_VERSION, nonce: freshNonce() });
    await new Promise<void>((resolve, reject) => {
      overflow.on('connect_error', () => resolve());
      overflow.on('connect', () => reject(new Error('should have been refused: too many unverified /runner sockets')));
    });

    // Freeing one slot (by disconnecting it) lets a new connection through — poll (bounded retry, not
    // a fixed sleep) since the server processes the client's disconnect asynchronously.
    const first = unverified.shift()!;
    first.disconnect();
    const runnerId = randomUUID();
    const Nr = freshNonce();
    let socket: Awaited<ReturnType<typeof connectRawRunner>> | undefined;
    let challenge: { nonce: string; proof: string } | undefined;
    for (let attempt = 0; !socket && attempt < 50; attempt++) {
      const candidate = await connectRawRunner(app, { runnerId, protocol: RUNNER_PROTOCOL_VERSION, nonce: Nr });
      const outcome = await new Promise<{ nonce: string; proof: string } | 'refused'>((resolve) => {
        candidate.on('runner:challenge', (c: { nonce: string; proof: string }) => resolve(c));
        candidate.on('connect_error', () => resolve('refused'));
      });
      if (outcome === 'refused') {
        candidate.disconnect();
        await new Promise((r) => setTimeout(r, 20));
      } else {
        socket = candidate;
        challenge = outcome;
      }
    }
    if (!socket || !challenge) throw new Error('gave up waiting for a freed unverified slot');
    const proof = computeProof(TOKEN, proofMessage(HMAC_CONTEXTS.runner, 'runner', challenge.nonce, Nr));
    const ack = await new Promise<{ ok: boolean }>((resolve) => socket!.emit('runner:prove', { proof }, resolve));
    expect(ack.ok).toBe(true);
    socket.disconnect();
    for (const s of unverified) s.disconnect();
  });

  // H1 regressions: runs.gateway.ts must never let a runner-controlled packet crash the process
  // (`ack is not a function`, or any other thrown error inside a listener). Each case is proven not
  // just by the offending socket getting disconnected, but by a well-behaved runner still being able
  // to complete a full handshake afterwards on the SAME server process.
  describe('H1: the server stays up no matter what a runner-namespace socket sends', () => {
    it('runner:prove sent with no ack callback disconnects the socket instead of crashing the process', async () => {
      app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true } } });
      const socket = await connectRawRunner(app, { runnerId: randomUUID(), protocol: RUNNER_PROTOCOL_VERSION, nonce: freshNonce() });
      const challenge = await new Promise<{ nonce: string; proof: string }>((resolve) => socket.on('runner:challenge', resolve));
      const disconnected = new Promise<void>((resolve) => socket.on('disconnect', () => resolve()));

      const proof = computeProof(TOKEN, proofMessage(HMAC_CONTEXTS.runner, 'runner', challenge.nonce, freshNonce()));
      socket.emit('runner:prove', { proof }); // no ack function at all
      await disconnected;

      const stillAlive = await connectVerifiedRunner(app, { token: TOKEN });
      stillAlive.close();
    });

    it('runner:hello sent with no ack callback disconnects the socket instead of crashing the process', async () => {
      app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true } } });
      const socket = await connectRawRunner(app, { runnerId: randomUUID(), protocol: RUNNER_PROTOCOL_VERSION, nonce: freshNonce() });
      const challenge = await new Promise<{ nonce: string; proof: string }>((resolve) => socket.on('runner:challenge', resolve));
      const runnerProof = computeProof(TOKEN, proofMessage(HMAC_CONTEXTS.runner, 'runner', challenge.nonce, freshNonce()));
      const proveAck = await new Promise<{ ok: boolean }>((resolve) => socket.emit('runner:prove', { proof: runnerProof }, resolve));
      expect(proveAck.ok).toBe(false); // wrong proof (mismatched Nr on purpose), but that's not the point here

      // Reconnect fresh and do a real prove, then send hello with no ack.
      const runnerId = randomUUID();
      const Nr = freshNonce();
      const socket2 = await connectRawRunner(app, { runnerId, protocol: RUNNER_PROTOCOL_VERSION, nonce: Nr });
      const challenge2 = await new Promise<{ nonce: string; proof: string }>((resolve) => socket2.on('runner:challenge', resolve));
      const proof2 = computeProof(TOKEN, proofMessage(HMAC_CONTEXTS.runner, 'runner', challenge2.nonce, Nr));
      const proveAck2 = await new Promise<{ ok: boolean }>((resolve) => socket2.emit('runner:prove', { proof: proof2 }, resolve));
      expect(proveAck2.ok).toBe(true);

      const disconnected = new Promise<void>((resolve) => socket2.on('disconnect', () => resolve()));
      socket2.emit('runner:hello', fakeHello({ runnerId })); // no ack function at all
      await disconnected;

      const stillAlive = await connectVerifiedRunner(app, { token: TOKEN });
      stillAlive.close();
    });

    it('garbage runner:prove/runner:hello payloads (with a real ack) get a clean ok:false, never a crash', async () => {
      app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true } } });
      const socket = await connectRawRunner(app, { runnerId: randomUUID(), protocol: RUNNER_PROTOCOL_VERSION, nonce: freshNonce() });
      await new Promise<void>((resolve) => socket.on('runner:challenge', () => resolve()));

      const garbageProveAck = await new Promise<{ ok: boolean }>((resolve) =>
        socket.emit('runner:prove', 'not-even-an-object', resolve),
      );
      expect(garbageProveAck.ok).toBe(false);
      socket.disconnect();

      const runnerId = randomUUID();
      const Nr = freshNonce();
      const socket2 = await connectRawRunner(app, { runnerId, protocol: RUNNER_PROTOCOL_VERSION, nonce: Nr });
      const challenge2 = await new Promise<{ nonce: string; proof: string }>((resolve) => socket2.on('runner:challenge', resolve));
      const proof2 = computeProof(TOKEN, proofMessage(HMAC_CONTEXTS.runner, 'runner', challenge2.nonce, Nr));
      const proveAck2 = await new Promise<{ ok: boolean }>((resolve) => socket2.emit('runner:prove', { proof: proof2 }, resolve));
      expect(proveAck2.ok).toBe(true);

      const garbageHelloAck = await new Promise<{ ok: boolean }>((resolve) => socket2.emit('runner:hello', { garbage: true }, resolve));
      expect(garbageHelloAck.ok).toBe(false);
      socket2.disconnect();

      const stillAlive = await connectVerifiedRunner(app, { token: TOKEN });
      stillAlive.close();
    });

    it('run:event/run:end (no ack) with garbage payloads are dropped silently, never a crash', async () => {
      app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true } } });
      const runner = await connectVerifiedRunner(app, { token: TOKEN });
      // These have no schema-valid shape at all; the handler must safeParse-and-drop, not throw.
      runner.socket.emit('run:event', { totally: 'wrong' });
      runner.socket.emit('run:end', 42);
      runner.socket.emit('run:event', null);

      const stillAlive = await connectVerifiedRunner(app, { token: TOKEN });
      stillAlive.close();
      runner.close();
    });
  });

  it('a newer verified connection (runner:hello) replaces an older one', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN, enabled: true } } });
    const runnerId = randomUUID();
    const first = await connectVerifiedRunner(app, { token: TOKEN, runnerId });
    const firstDisconnected = new Promise<void>((resolve) => first.socket.on('disconnect', () => resolve()));
    const second = await connectVerifiedRunner(app, { token: TOKEN, runnerId });
    await firstDisconnected;
    expect(app.diContainer.cradle.runsService.getRunnerStatus().connected).toBe(true);
    second.close();
  });
});
