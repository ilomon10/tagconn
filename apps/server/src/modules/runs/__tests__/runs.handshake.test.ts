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
    app = await buildTestApp({ settings: { runner: { token: TOKEN } } });
    const runner = await connectVerifiedRunner(app, { token: TOKEN });
    const status = app.diContainer.cradle.runsService.getRunnerStatus();
    expect(status).toMatchObject({ connected: true, verified: true, runnerId: runner.runnerId });
    runner.close();
  });

  it('a fake runner client can detect an impersonating/squatter server: the challenge proof only matches the real token', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN } } });
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
    app = await buildTestApp({ settings: { runner: { token: TOKEN } } });
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
    app = await buildTestApp({ settings: { runner: { token: TOKEN } } });
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
    app = await buildTestApp({ settings: { runner: { token: TOKEN } } });
    const socket = await connectRawRunner(app, { runnerId: randomUUID(), protocol: RUNNER_PROTOCOL_VERSION, nonce: freshNonce() });
    await new Promise<void>((resolve) => socket.on('runner:challenge', () => resolve()));

    const disconnected = new Promise<void>((resolve) => socket.on('disconnect', () => resolve()));
    socket.emit('runner:hello', fakeHello({}), () => {});
    await disconnected;
  });

  it('a newer verified connection (runner:hello) replaces an older one', async () => {
    app = await buildTestApp({ settings: { runner: { token: TOKEN } } });
    const runnerId = randomUUID();
    const first = await connectVerifiedRunner(app, { token: TOKEN, runnerId });
    const firstDisconnected = new Promise<void>((resolve) => first.socket.on('disconnect', () => resolve()));
    const second = await connectVerifiedRunner(app, { token: TOKEN, runnerId });
    await firstDisconnected;
    expect(app.diContainer.cradle.runsService.getRunnerStatus().connected).toBe(true);
    second.close();
  });
});
