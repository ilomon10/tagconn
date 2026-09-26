// Thin adapter from real socket.io-client to the socket-agnostic handshake.ts / runManager.ts logic.
// This is the only file that imports 'socket.io-client'; everything it wraps is unit-tested against
// a hand-rolled SocketLike fake (see handshake.ts and test/unit/handshake.test.ts), plus an
// integration test against a real socket.io server (test/unit/runnerProtocol.test.ts).

import { io, type Socket } from 'socket.io-client';
import { RUNNER_NAMESPACE, RUNNER_PROTOCOL_VERSION, type RunnerHandshakeAuth } from '@tagconn/shared';
import { performHandshake, type HandshakeHandle, type SocketLike } from './handshake.js';
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
    disconnect: () => {
      // R1 (SC5 re-review): NEVER `socket.disconnect()` here. That is a MANUAL disconnect — it calls
      // through to the Manager's `_destroy`/`_close`, which sets `skipReconnect = true` permanently
      // (the same path an intentional app-level "log out" takes) — so after a single bad server proof
      // this runner would sit disconnected forever and never even exit for systemd `Restart=on-failure`
      // to kick in. Closing only the underlying engine.io transport drops this (possibly-impersonating)
      // peer just the same, but leaves socket.io-client's own reconnection loop running: it retries with
      // a fresh nonce exactly as it would after an ordinary network blip.
      socket.io.engine.close();
    },
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
  // R1 (SC5 re-review): bumped on every 'connect', and captured per handshake attempt. A handshake
  // whose result resolves after a LATER connection attempt has already started (e.g. a stale
  // `runner:prove` ack rejection arriving after 'disconnect' already fired and a reconnect is under
  // way) is recognized as superseded and ignored, instead of racing with — or clobbering — the newer
  // attempt's own outcome.
  let generation = 0;
  let pendingHandshake: HandshakeHandle | undefined;
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
    const gen = ++generation;
    const handshake = performHandshake(adapt(socket), opts.token, nr);
    pendingHandshake = handshake;
    void handshake.result.then((result) => {
      if (gen !== generation) return; // R1: superseded by a later connection attempt; ignore.
      if (pendingHandshake === handshake) pendingHandshake = undefined;
      if (result.verified) {
        verified = true;
        opts.onVerified();
      }
      // else: a genuine handshake failure already closed the transport (adapt()'s `disconnect`, which
      // is NOT a manual disconnect — see there); socket.io-client's own reconnection is still enabled
      // and will retry with a fresh nonce. A drop mid-handshake (cancel(), below) needs no action here
      // at all: the transport is already gone and reconnection was never disabled by it.
    });
  });

  // H1 (L5): the instant the transport drops, this connection is no longer verified — command
  // handlers must stop acting immediately, before any reconnect (to a possibly different peer) can
  // complete a fresh handshake. Also drop anything socket.io-client itself still has queued to flush
  // automatically on the NEXT connect (before our own re-verification), e.g. an emit that raced the
  // disconnect: sendBuffer is otherwise flushed by socket.io-client on reconnect regardless of app-level
  // verification state.
  //
  // R1 (SC5 re-review): also settle+clean up a still-pending handshake for the connection that just
  // dropped (a drop before `runner:challenge` ever arrived, or after `runner:prove` was sent but before
  // its ack). Without this, that handshake's `onAny`/'runner:challenge' listeners stay registered on
  // this reused Socket, fire again on the NEXT (re)connection's fresh challenge, judge it against THIS
  // attempt's stale nonce, and wrongly fail it.
  socket.on('disconnect', () => {
    verified = false;
    socket.sendBuffer.length = 0;
    pendingHandshake?.cancel();
    pendingHandshake = undefined;
  });

  return { socket, isVerified: () => verified };
}
