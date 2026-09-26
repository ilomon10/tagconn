// Wires a VERIFIED /runner socket to the run manager: `runner:hello` (ack unwrapping, killRunIds,
// offline replay), `run:start` / `run:stop` / `attribution:write`. Extracted out of main.ts so it can
// be exercised directly in an integration test against a fake server (test/unit/runnerProtocol.test.ts)
// without booting the whole daemon (config load, capability probe, real socket.io-client connect).
//
// Ack shape: packages/shared/src/socket.ts `Ack<T>` = `{ok:true,data:T} | {ok:false,error:string}`.
// This is the envelope BOTH directions use: what the server sends us for `runner:hello`, and what we
// must send back for `run:start` / `attribution:write` (mirrors apps/server's `runsAck` helper).

import { join } from 'node:path';
import {
  type AttributionWriteCommand,
  type RunnerHello,
  type RunnerHelloAckData,
  RunStartCommandSchema,
} from '@tagconn/shared';
import type { Socket } from 'socket.io-client';
import { writeAttributionProfile } from './attributionWrite.js';
import type { OfflineQueue } from './buffer.js';
import type { Logger } from './logger.js';
import type { RunManager } from './runManager.js';

export type AckEnvelope<T> = { ok: true; data: T } | { ok: false; error: string };
export const ackOk = <T,>(data: T): AckEnvelope<T> => ({ ok: true, data });
export const ackErr = (error: string): AckEnvelope<never> => ({ ok: false, error });

export interface WireRunnerSocketDeps {
  runManager: RunManager;
  offlineQueue: OfflineQueue;
  /** Only the fields this file needs (stateDir for the docs --add-dir path, allowedProjectDirs for attribution:write). */
  cfg: { stateDir: string; allowedProjectDirs: readonly string[] };
  hello: RunnerHello;
  logger: Logger;
  /**
   * H1: true only between a successful mutual-HMAC handshake and the next 'disconnect' on THIS
   * socket. socket.io-client reuses the same Socket across reconnects and dispatches `onAny`
   * listeners and then ALWAYS the normal per-event listeners for the same packet, so a fake server
   * sending `run:start` before (or instead of) completing the handshake is not reliably stopped by
   * the handshake's own disconnect call — every command handler below checks this flag itself.
   */
  isVerified(): boolean;
}

/**
 * Installs the `run:start` / `run:stop` / `attribution:write` handlers on `sock`. H1: call this
 * EXACTLY ONCE per socket (socket.io-client hands back the same Socket object across reconnects —
 * re-registering these on every reconnect duplicates them, so one `run:start` from the server would
 * spawn N processes after N reconnects). Each handler is gated on `deps.isVerified()` and does
 * nothing at all on an unverified/disconnected connection (H1's actual control; see socketClient.ts).
 * Call `announceVerified` separately, once per successful (re)verification.
 */
export function wireRunnerSocket(sock: Socket, deps: WireRunnerSocketDeps): void {
  // ServerToRunnerEvents 'run:start': ack {ok:true,data:{pid}} PROMPTLY. pid:null is still an "ok" ack
  // (a normal refusal the server maps to rejected/spawn_failed); {ok:false} is reserved for a
  // wire-level ack failure, never used for an ordinary policy refusal.
  sock.on('run:start', (cmd: unknown, ack: (res: AckEnvelope<{ pid: number | null }>) => void) => {
    if (!deps.isVerified()) return; // H1: never act on a command from an unverified/stale connection
    const parsed = RunStartCommandSchema.safeParse(cmd);
    if (!parsed.success) {
      ack(ackOk({ pid: null }));
      // Best-effort run:end so the server can mark the run rejected/invalid_command even though the
      // payload itself failed schema validation (it may still carry a usable runId).
      const maybeRunId = typeof (cmd as { runId?: unknown } | null)?.runId === 'string' ? (cmd as { runId: string }).runId : undefined;
      // Safe to emit directly (not via the offline queue): isVerified() was just checked above, and
      // nothing async happens in between on this synchronous path.
      if (maybeRunId) sock.emit('run:end', { runId: maybeRunId, status: 'rejected', reason: 'invalid_command', exitCode: null, signal: null });
      return;
    }
    const c = parsed.data;
    const result = c.readOnly
      ? deps.runManager.startReceptionist(c, { scope: c.projectDir ? 'project' : 'general', addDirDocs: c.addTagconnDocs ? join(deps.cfg.stateDir, 'receptionist-docs') : undefined })
      : deps.runManager.startQuest(c);
    ack(ackOk(result));
  });

  // The server also sends reason 'timeout' when its own event caps trip; runManager.stop() treats
  // every reason the same way (a normal stop), and reports the run ended with that same status/reason.
  sock.on('run:stop', (cmd: { runId: string; reason: 'stopped_by_user' | 'timeout' | 'runner_shutdown' }) => {
    if (!deps.isVerified()) return;
    deps.runManager.stop(cmd);
  });

  sock.on('attribution:write', (cmd: AttributionWriteCommand, ack: (res: AckEnvelope<unknown>) => void) => {
    if (!deps.isVerified()) return;
    try {
      ack(ackOk(writeAttributionProfile(cmd, deps.cfg.allowedProjectDirs)));
    } catch (err) {
      ack(ackErr(err instanceof Error ? err.message : String(err)));
    }
  });
}

/**
 * Sends `runner:hello` and processes its ack (killRunIds, offline replay). H1: call this every time a
 * (re)connection completes the mutual HMAC handshake — unlike `wireRunnerSocket`, this does NOT
 * register any listeners, so calling it repeatedly across reconnects is exactly the intended behavior
 * (the server needs a fresh `runner:hello` after every reconnect to reconcile runs).
 */
export function announceVerified(sock: Socket, deps: Pick<WireRunnerSocketDeps, 'runManager' | 'offlineQueue' | 'hello' | 'logger'>): void {
  sock.emit('runner:hello', deps.hello, (res: AckEnvelope<RunnerHelloAckData>) => {
    if (!res.ok) {
      deps.logger.error('runner:hello rejected by server', { error: res.error });
      return;
    }
    // Runs the server no longer knows about (e.g. after its own restart) must be killed here.
    for (const runId of res.data.killRunIds) deps.runManager.stop({ runId, reason: 'runner_shutdown' });
    for (const item of deps.offlineQueue.drain()) {
      if (item.type === 'event') sock.emit('run:event', item.envelope);
      else sock.emit('run:end', item.end);
    }
  });
}
