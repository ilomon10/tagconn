// tagconn Desktop sidecar (docs/design/desktop.md, task E). Newline-delimited JSON-RPC on stdin/stdout
// (packages/shared/src/desktop.ts). stdout carries ONLY protocol messages; every diagnostic goes to stderr.

import { createInterface } from 'node:readline';
import { createRpcServer } from './protocol.ts';
import { createSupervisor } from './supervisor.ts';

// Anything that prints (a dependency, a stray console.log) must not corrupt the protocol stream.
console.log = console.error;
console.info = console.error;

// When the desktop app dies, its pipes break. Writing to a broken stderr raises an async EPIPE, and
// logging that error to the same stderr raised another one: an endless loop that left an orphaned,
// CPU-spinning supervisor. So: stop writing to a pipe once it has failed, and treat a broken pipe as
// "the app is gone" (stop the services, then exit), never as something to log.
let stderrOk = true;
let stdoutOk = true;
process.stderr.on('error', () => {
  stderrOk = false;
});
const stderr = (line: string) => {
  if (!stderrOk) return;
  try {
    process.stderr.write(line + '\n');
  } catch {
    stderrOk = false;
  }
};
const stdoutWrite = process.stdout.write.bind(process.stdout);
const write = (message: object) => {
  if (!stdoutOk) return;
  try {
    stdoutWrite(JSON.stringify(message) + '\n');
  } catch {
    stdoutOk = false;
  }
};

process.stdout.on('error', () => {
  stdoutOk = false;
  void shutdown(0); // the desktop app went away: stop the services, then exit
});

const supervisor = createSupervisor({
  notify: (method, params) => write({ method, params }),
  stderr,
});
const rpc = createRpcServer({ handlers: supervisor.handlers, write, logErr: stderr });

let shuttingDown = false;
/** Longest a shutdown may take (services get SIGTERM, then a tree kill) before we exit regardless. */
const SHUTDOWN_DEADLINE_MS = 25_000;
async function shutdown(code: number): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true;
    setTimeout(() => process.exit(code), SHUTDOWN_DEADLINE_MS).unref();
    stderr('[supervisor] shutting down: stopping all services');
    await supervisor.shutdown();
    await rpc.idle();
    await supervisor.shutdown(); // a start that raced in while stopping
  }
  process.exit(code);
}

process.on('uncaughtException', (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
    void shutdown(0); // a pipe to the app broke: never log it (that is what used to loop)
    return;
  }
  stderr(`[supervisor] uncaught exception: ${err.stack ?? err}`);
});
process.on('unhandledRejection', (err) => stderr(`[supervisor] unhandled rejection: ${String(err)}`));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => void shutdown(0));

supervisor.cleanStale();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => void rpc.handleLine(line));
input.on('close', () => void shutdown(0)); // stdin EOF = the app closed or died

// Belt and braces: if the app was killed so hard that neither stdin EOF nor a pipe error reached us,
// notice that our parent is gone (POSIX re-parents orphans; the parent pid changes) and stop.
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) void shutdown(0);
}, 2_000).unref();
