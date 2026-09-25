// Mutual HMAC handshake state machine, runner side (docs/design/runner-and-helpdesk.md §2.2).
// Deliberately socket.io-agnostic (a minimal `SocketLike`) so the protocol logic is unit-testable
// without a live server or the socket.io-client dependency; socketClient.ts adapts a real socket.

import { expectedServerProof, runnerProof, verifyProof } from './hmac.js';

export interface SocketLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
  /** socket.io's ack-style emit, promisified by the adapter. Rejects on a server-side ack error / timeout. */
  emitWithAck<T>(event: string, payload?: unknown): Promise<T>;
  /** Registers a catch-all listener (socket.io-client's `onAny`), used to enforce the pre-verification guard. */
  onAny?(handler: (event: string, ...args: unknown[]) => void): void;
  disconnect(): void;
}

export interface HandshakeResult {
  verified: boolean;
  /** Present when rejected: why the runner disconnected (never acts on the socket after this). */
  reason?: string;
}

/**
 * Runs the client side of the handshake: waits for `runner:challenge`, verifies the server's proof
 * (bad proof -> disconnect, never act on anything from this socket), sends `runner:prove`, and
 * resolves once the server acks it. Any OTHER event arriving before verification also disconnects
 * (guarded via `onAny` when the socket supports it).
 */
export function performHandshake(socket: SocketLike, token: string, nr: string): Promise<HandshakeResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: HandshakeResult) => {
      if (settled) return;
      settled = true;
      if (!result.verified) socket.disconnect();
      resolvePromise(result);
    };

    socket.onAny?.((event) => {
      if (!settled && event !== 'runner:challenge') {
        finish({ verified: false, reason: `unexpected event "${event}" before verification` });
      }
    });

    socket.on('runner:challenge', (challenge) => {
      if (settled) return;
      const c = challenge as { nonce?: unknown; proof?: unknown };
      if (typeof c.nonce !== 'string' || typeof c.proof !== 'string') {
        finish({ verified: false, reason: 'malformed challenge' });
        return;
      }
      const expected = expectedServerProof(token, nr, c.nonce);
      if (!verifyProof(expected, c.proof)) {
        finish({ verified: false, reason: 'server proof invalid: wrong URL or impersonator' });
        return;
      }
      const proof = runnerProof(token, c.nonce, nr);
      socket
        .emitWithAck<true>('runner:prove', { proof })
        .then(() => finish({ verified: true }))
        .catch((err: unknown) => finish({ verified: false, reason: `prove rejected: ${String(err)}` }));
    });
  });
}
