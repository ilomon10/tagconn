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
  /** Records the live socket so run:event/run:end (emitted elsewhere, via runManager's deps) can reach it. */
  setCurrentSocket(socket: Socket): void;
}

/**
 * Sends `runner:hello` and installs the `run:start` / `run:stop` / `attribution:write` handlers.
 * Call once per newly VERIFIED connection (after the mutual HMAC handshake — see handshake.ts /
 * socketClient.ts).
 */
export function wireRunnerSocket(sock: Socket, deps: WireRunnerSocketDeps): void {
  deps.setCurrentSocket(sock);

  sock.emit('runner:hello', deps.hello, (res: AckEnvelope<RunnerHelloAckData>) => {
    if (!res.ok) {
      deps.logger.error('runner:hello rejected by server', { error: res.error });
      return;
    }
    // Runs the server no longer knows about (e.g. after its own restart) must be killed here.
    for (const runId of res.data.killRunIds) deps.runManager.stop({ runId, reason: 'runner_shutdown' });
    for (const env of deps.offlineQueue.drain()) sock.emit('run:event', env);
  });

  // ServerToRunnerEvents 'run:start': ack {ok:true,data:{pid}} PROMPTLY. pid:null is still an "ok" ack
  // (a normal refusal the server maps to rejected/spawn_failed); {ok:false} is reserved for a
  // wire-level ack failure, never used for an ordinary policy refusal.
  sock.on('run:start', (cmd: unknown, ack: (res: AckEnvelope<{ pid: number | null }>) => void) => {
    const parsed = RunStartCommandSchema.safeParse(cmd);
    if (!parsed.success) {
      ack(ackOk({ pid: null }));
      // Best-effort run:end so the server can mark the run rejected/invalid_command even though the
      // payload itself failed schema validation (it may still carry a usable runId).
      const maybeRunId = typeof (cmd as { runId?: unknown } | null)?.runId === 'string' ? (cmd as { runId: string }).runId : undefined;
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
    deps.runManager.stop(cmd);
  });

  sock.on('attribution:write', (cmd: AttributionWriteCommand, ack: (res: AckEnvelope<unknown>) => void) => {
    try {
      ack(ackOk(writeAttributionProfile(cmd, deps.cfg.allowedProjectDirs)));
    } catch (err) {
      ack(ackErr(err instanceof Error ? err.message : String(err)));
    }
  });
}
