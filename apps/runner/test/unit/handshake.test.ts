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
    const promise = performHandshake(fake.socket, TOKEN, nr);

    const ns = randomNonce();
    const proof = expectedServerProof(TOKEN, nr, ns);
    fake.fire('runner:challenge', { nonce: ns, proof });

    const result = await promise;
    expect(result.verified).toBe(true);
    expect(fake.emits[0]?.event).toBe('runner:prove');
    expect(fake.isDisconnected()).toBe(false);
  });

  it('disconnects and never proves on a bad server proof (wrong URL / impersonator)', async () => {
    const fake = makeFakeSocket();
    const nr = randomNonce();
    const promise = performHandshake(fake.socket, TOKEN, nr);

    fake.fire('runner:challenge', { nonce: randomNonce(), proof: 'not-the-real-proof-xxxxxxxxxxxxxxxxxxxxxxxxx' });

    const result = await promise;
    expect(result.verified).toBe(false);
    expect(fake.emits).toHaveLength(0); // never proves
    expect(fake.isDisconnected()).toBe(true);
  });

  it('rejects a malformed challenge without throwing', async () => {
    const fake = makeFakeSocket();
    const promise = performHandshake(fake.socket, TOKEN, randomNonce());
    fake.fire('runner:challenge', { nonce: 123, proof: null });
    const result = await promise;
    expect(result.verified).toBe(false);
  });

  it('disconnects if the server acks runner:prove with an error', async () => {
    const fake = makeFakeSocket();
    fake.setAck(() => Promise.reject(new Error('bad proof')));
    const nr = randomNonce();
    const promise = performHandshake(fake.socket, TOKEN, nr);
    const ns = randomNonce();
    fake.fire('runner:challenge', { nonce: ns, proof: expectedServerProof(TOKEN, nr, ns) });
    const result = await promise;
    expect(result.verified).toBe(false);
    expect(fake.isDisconnected()).toBe(true);
  });
});
