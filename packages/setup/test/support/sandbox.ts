import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { createContext, type SetupContext } from '../../src/index.ts';

const dirs: string[] = [];

/** A fresh temp dir under the OS tmpdir. Every test passes explicit dirs derived from it, never real ones. */
export function tempDir(prefix = 'tagconn-setup-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

export interface Logs {
  out: string[];
  err: string[];
}

/** A context that captures its output instead of printing. */
export function quietContext(partial: Partial<SetupContext> = {}): { ctx: SetupContext; logs: Logs } {
  const logs: Logs = { out: [], err: [] };
  const ctx = createContext({ log: (m) => logs.out.push(m), warn: (m) => logs.err.push(m), ...partial });
  return { ctx, logs };
}
