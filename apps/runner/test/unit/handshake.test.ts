import { describe, expect, it } from 'vitest';
import { performHandshake, type SocketLike } from '../../src/handshake.js';
import { expectedServerProof, randomNonce } from '../../src/hmac.js';

const TOKEN = 'c'.repeat(32);

/** A minimal fake socket.io Socket: records emits, lets the test fire incoming events manually. */
function makeFakeSocket() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const emits: { event: string; payload: unknown }[] = [];
  let disconnected = false;
  let ackImpl: (event: string, payload: unknown) => Promise<unknown> = () => Promise.resolve(true);

  const socket: SocketLike = {
    on: (event, handler) => handlers.set(event, handler as (p: unknown) => void),
    emitWithAck: (event, payload) => {
      emits.push({ event, payload });
      return ackImpl(event, payload) as Promise<never>;
    },
    disconnect: () => {
      disconnected = true;
    },
  };
  return {
    socket,
    emits,
    fire: (event: string, payload: unknown) => handlers.get(event)?.(payload),
    isDisconnected: () => disconnected,
    setAck: (impl: typeof ackImpl) => {
      ackImpl = impl;
    },
  };
}

describe('performHandshake (runner side)', () => {
  it('verifies a correct server proof, sends runner:prove, and resolves verified on ack', async () => {
    const fake = makeFakeSocket();
    const nr = randomNonce();
    const handle = performHandshake(fake.socket, TOKEN, nr);

    const ns = randomNonce();
    const proof = expectedServerProof(TOKEN, nr, ns);
    fake.fire('runner:challenge', { nonce: ns, proof });

    const result = await handle.result;
    expect(result.verified).toBe(true);
    expect(fake.emits[0]?.event).toBe('runner:prove');
    expect(fake.isDisconnected()).toBe(false);
  });

  it('disconnects and never proves on a bad server proof (wrong URL / impersonator)', async () => {
    const fake = makeFakeSocket();
    const nr = randomNonce();
    const handle = performHandshake(fake.socket, TOKEN, nr);

    fake.fire('runner:challenge', { nonce: randomNonce(), proof: 'not-the-real-proof-xxxxxxxxxxxxxxxxxxxxxxxxx' });

    const result = await handle.result;
    expect(result.verified).toBe(false);
    expect(fake.emits).toHaveLength(0); // never proves
    expect(fake.isDisconnected()).toBe(true);
  });

  it('rejects a malformed challenge without throwing', async () => {
    const fake = makeFakeSocket();
    const handle = performHandshake(fake.socket, TOKEN, randomNonce());
    fake.fire('runner:challenge', { nonce: 123, proof: null });
    const result = await handle.result;
    expect(result.verified).toBe(false);
  });

  it('disconnects if the server acks runner:prove with an error', async () => {
    const fake = makeFakeSocket();
    fake.setAck(() => Promise.reject(new Error('bad proof')));
    const nr = randomNonce();
    const handle = performHandshake(fake.socket, TOKEN, nr);
    const ns = randomNonce();
    fake.fire('runner:challenge', { nonce: ns, proof: expectedServerProof(TOKEN, nr, ns) });
    const result = await handle.result;
    expect(result.verified).toBe(false);
    expect(fake.isDisconnected()).toBe(true);
  });

  // ---------------------------------------------------------------------------------------- R1 (SC5 re-review)

  it('cancel() before the challenge arrives settles unverified WITHOUT calling socket.disconnect()', async () => {
    const fake = makeFakeSocket();
    const handle = performHandshake(fake.socket, TOKEN, randomNonce());

    handle.cancel();
    const result = await handle.result;
    expect(result.verified).toBe(false);
    expect(fake.isDisconnected()).toBe(false); // R1: cancel() must never be a (manual) disconnect

    // A challenge that arrives after cancel() must be ignored (listeners were removed).
    fake.fire('runner:challenge', { nonce: randomNonce(), proof: 'irrelevant' });
    expect(fake.emits).toHaveLength(0);
  });

  it('cancel() after runner:prove was sent but before its ack settles unverified WITHOUT calling socket.disconnect()', async () => {
    const fake = makeFakeSocket();
    let resolveAck: (() => void) | undefined;
    fake.setAck(() => new Promise((resolve) => (resolveAck = () => resolve(true))));
    const nr = randomNonce();
    const handle = performHandshake(fake.socket, TOKEN, nr);
    const ns = randomNonce();
    fake.fire('runner:challenge', { nonce: ns, proof: expectedServerProof(TOKEN, nr, ns) });
    expect(fake.emits[0]?.event).toBe('runner:prove'); // sent, ack still pending

    handle.cancel();
    const result = await handle.result;
    expect(result.verified).toBe(false);
    expect(fake.isDisconnected()).toBe(false);

    // The ack finally arriving late must not throw or otherwise re-settle anything observable.
    resolveAck?.();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('cancel() is a no-op once the handshake has already settled itself', async () => {
    const fake = makeFakeSocket();
    const nr = randomNonce();
    const handle = performHandshake(fake.socket, TOKEN, nr);
    const ns = randomNonce();
    fake.fire('runner:challenge', { nonce: ns, proof: expectedServerProof(TOKEN, nr, ns) });
    const result = await handle.result;
    expect(result.verified).toBe(true);

    handle.cancel(); // must not flip anything or throw
    expect(fake.isDisconnected()).toBe(false);
  });
});
