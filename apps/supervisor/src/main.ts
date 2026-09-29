// tagconn Desktop sidecar (docs/design/desktop.md, task E). Newline-delimited JSON-RPC on stdin/stdout
// (packages/shared/src/desktop.ts). stdout carries ONLY protocol messages; every diagnostic goes to stderr.

import { createInterface } from 'node:readline';
import { createRpcServer } from './protocol.ts';
import { createSupervisor } from './supervisor.ts';

// Anything that prints (a dependency, a stray console.log) must not corrupt the protocol stream.
console.log = console.error;
console.info = console.error;

const stderr = (line: string) => process.stderr.write(line + '\n');
const stdoutWrite = process.stdout.write.bind(process.stdout);
const write = (message: object) => void stdoutWrite(JSON.stringify(message) + '\n');

process.stdout.on('error', () => process.exit(0)); // the desktop app went away

const supervisor = createSupervisor({
  notify: (method, params) => write({ method, params }),
  stderr,
});
const rpc = createRpcServer({ handlers: supervisor.handlers, write, logErr: stderr });

let shuttingDown = false;
async function shutdown(code: number): Promise<never> {
  if (!shuttingDown) {
    shuttingDown = true;
    stderr('[supervisor] shutting down: stopping all services');
    await supervisor.shutdown();
    await rpc.idle();
    await supervisor.shutdown(); // a start that raced in while stopping
  }
  process.exit(code);
}

process.on('uncaughtException', (err) => stderr(`[supervisor] uncaught exception: ${err.stack ?? err}`));
process.on('unhandledRejection', (err) => stderr(`[supervisor] unhandled rejection: ${String(err)}`));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => void shutdown(0));

supervisor.cleanStale();
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => void rpc.handleLine(line));
input.on('close', () => void shutdown(0)); // stdin EOF = the app closed or died
