import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { ServiceStatus } from '@tagconn/shared';

export const FAKE_CHILD = new URL('./fixtures/fake-child.mjs', import.meta.url).pathname;

/** A fresh temp dir. Set TAGCONN_TEST_TMP to keep test files inside the agent scratchpad. */
export const tempDir = (prefix = 'tagconn-sup-'): string => mkdtempSync(join(process.env.TAGCONN_TEST_TMP ?? tmpdir(), prefix));

export async function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 5_000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function recorder() {
  const statuses: ServiceStatus[] = [];
  return { statuses, onChange: (s: ServiceStatus) => statuses.push(s), states: () => statuses.map((s) => s.state) };
}

/** A ChildProcess look-alike for mocked-platform tests. */
export function fakeChildProcess(pid: number): ChildProcess & { die: (code?: number | null, signal?: NodeJS.Signals | null) => void } {
  const child = new EventEmitter() as ChildProcess & { die: (code?: number | null, signal?: NodeJS.Signals | null) => void };
  Object.assign(child, { pid, stdout: new PassThrough(), stderr: new PassThrough() });
  child.die = (code = 0, signal = null) => child.emit('exit', code, signal);
  return child;
}
