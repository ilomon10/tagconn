// Thin adapter from real socket.io-client to the socket-agnostic handshake.ts / runManager.ts logic.
// This is the only file that imports 'socket.io-client'; everything it wraps is unit-tested against
// a hand-rolled SocketLike fake (see handshake.ts and test/unit/handshake.test.ts), plus an
// integration test against a real socket.io server (test/unit/socketClient.integration.test.ts).

import { io, type Socket } from 'socket.io-client';
import { RUNNER_NAMESPACE, RUNNER_PROTOCOL_VERSION, type RunnerHandshakeAuth } from '@tagconn/shared';
import { performHandshake, type SocketLike } from './handshake.js';
import { randomNonce } from './hmac.js';

/** The server's ack envelope (packages/shared/src/socket.ts `Ack<T>`), unwrapped here so the rest of
 *  the runner's code (handshake.ts, main.ts) works with plain resolved values / thrown errors. */
type AckEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };

function adapt(socket: Socket): SocketLike {
  return {
    on: (event, handler) => {
      socket.on(event, handler as (...args: unknown[]) => void);
    },
    onAny: (handler) => socket.onAny(handler),
    emitWithAck: <T,>(event: string, payload?: unknown) =>
      new Promise<T>((resolve, reject) => {
        socket.timeout(10_000).emit(event, payload, (err: unknown, res: AckEnvelope<T>) => {
          if (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          } else if (res.ok) {
            resolve(res.data);
          } else {
            reject(new Error(res.error));
          }
        });
      }),
    disconnect: () => socket.disconnect(),
  };
}

export interface ConnectOptions {
  url: string;
  token: string;
  runnerId: string;
  onSocket(socket: Socket): void;
}

/**
 * Connects to `<url><RUNNER_NAMESPACE>`, runs the mutual HMAC handshake, and calls `onSocket` with the
 * live, verified socket.io Socket once (and only once) it is safe to send `runner:hello` and start
 * accepting `run:start`. Reconnects are socket.io's own responsibility; each (re)connection attempt
 * gets a FRESH Nr (the `auth` callback form re-runs before every attempt, per socket.io-client), and
 * each `connect` event repeats the whole handshake against that attempt's nonce.
 */
export function connectRunner(opts: ConnectOptions): Socket {
  let currentNr = '';
  const socket = io(opts.url + RUNNER_NAMESPACE, {
    auth: (cb: (data: RunnerHandshakeAuth) => void) => {
      currentNr = randomNonce();
      cb({ runnerId: opts.runnerId, protocol: RUNNER_PROTOCOL_VERSION, nonce: currentNr });
    },
    // The runner never sends an Origin header (§2.2 step 1): Node's socket.io-client / engine.io-client
    // does not add one unless explicitly configured via extraHeaders, which we never do.
    reconnection: true,
    randomizationFactor: 0.5,
  });

  socket.on('connect', () => {
    const nr = currentNr;
    void performHandshake(adapt(socket), opts.token, nr).then((result) => {
      if (result.verified) opts.onSocket(socket);
      // else: performHandshake already disconnected; socket.io will retry with a fresh nonce.
    });
  });

  return socket;
}
