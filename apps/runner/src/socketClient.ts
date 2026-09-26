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
    off: (event, handler) => {
      socket.off(event, handler as (...args: unknown[]) => void);
    },
    onAny: (handler) => socket.onAny(handler),
    offAny: (handler) => socket.offAny(handler),
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
  /**
   * Called every time a (re)connection completes the mutual HMAC handshake (H1: this is NOT "once
   * per process" — it fires again after every reconnect). The caller should re-send `runner:hello`
   * and drain the offline queue here; it must NOT re-register 'run:start'/'run:stop'/
   * 'attribution:write' listeners on `connection.socket` (do that exactly once, gated by
   * `connection.isVerified()`; see wireSocket.ts).
   */
  onVerified(): void;
}

export interface RunnerConnection {
  socket: Socket;
  /**
   * True only between a successful handshake and the next 'disconnect' (H1). socket.io-client REUSES
   * the same Socket across reconnects and dispatches `onAny` listeners and then ALWAYS the normal
   * per-event listeners for the same packet — so a command handler registered once on this socket
   * (wireSocket.ts) MUST check this flag itself before acting; it cannot rely on the handshake having
   * disconnected an impersonating peer in time.
   */
  isVerified(): boolean;
}

/**
 * Connects to `<url><RUNNER_NAMESPACE>` and runs the mutual HMAC handshake on every (re)connection.
 * Reconnects are socket.io's own responsibility; each (re)connection attempt gets a FRESH Nr (the
 * `auth` callback form re-runs before every attempt, per socket.io-client), and each `connect` event
 * repeats the whole handshake against that attempt's nonce.
 */
export function connectRunner(opts: ConnectOptions): RunnerConnection {
  let currentNr = '';
  let verified = false;
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
      if (result.verified) {
        verified = true;
        opts.onVerified();
      }
      // else: performHandshake already disconnected; socket.io will retry with a fresh nonce.
    });
  });

  // H1 (L5): the instant the transport drops, this connection is no longer verified — command
  // handlers must stop acting immediately, before any reconnect (to a possibly different peer) can
  // complete a fresh handshake. Also drop anything socket.io-client itself still has queued to flush
  // automatically on the NEXT connect (before our own re-verification), e.g. an emit that raced the
  // disconnect: sendBuffer is otherwise flushed by socket.io-client on reconnect regardless of app-level
  // verification state.
  socket.on('disconnect', () => {
    verified = false;
    socket.sendBuffer.length = 0;
  });

  return { socket, isVerified: () => verified };
}
