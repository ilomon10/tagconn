// Session resume ledger (docs/design/runner-and-helpdesk.md §2.3 step 7, §2.7 "session ledger").
//
// Resume (`--resume=<sid>`) is only allowed for a session id this runner itself created (from an
// `init` event), AND only if the tool fingerprint is unchanged. V15 ("resume with changed flags") was
// never empirically run against the real CLI, so this is fail-closed: a fingerprint mismatch, or an
// unknown session id, both refuse with `resume_not_allowed`.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LedgerEntry {
  fingerprint: string;
  createdAt: number;
}

export type Ledger = Map<string, LedgerEntry>;

/** Sorted tools + mode + restricted/safe flags (+ webFetch domains for the Receptionist), canonicalized. */
export function computeFingerprint(opts: {
  tools: readonly string[];
  mode: string;
  restricted: boolean;
  safeMode: boolean;
  webFetchDomains?: readonly string[];
}): string {
  const parts = {
    tools: [...opts.tools].sort(),
    mode: opts.mode,
    restricted: opts.restricted,
    safeMode: opts.safeMode,
    webFetchDomains: [...(opts.webFetchDomains ?? [])].sort(),
  };
  return JSON.stringify(parts);
}

export function loadLedger(path: string): Ledger {
  if (!existsSync(path)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, LedgerEntry>;
    return new Map(Object.entries(raw));
  } catch {
    // A corrupt ledger fails closed: start empty rather than trust unparsable data.
    return new Map();
  }
}

export function saveLedger(path: string, ledger: Ledger): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const obj = Object.fromEntries(ledger);
  const tmp = join(dir, `.${Date.now()}.${process.pid}.ledger.tmp`);
  writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Records a newly created session id, evicting the oldest entry (insertion order) past `maxSize`. */
export function recordSession(ledger: Ledger, sessionId: string, fingerprint: string, maxSize: number): void {
  ledger.delete(sessionId); // re-insert at the end (most recent) if it already existed
  ledger.set(sessionId, { fingerprint, createdAt: Date.now() });
  while (ledger.size > maxSize) {
    const oldestKey = ledger.keys().next().value;
    if (oldestKey === undefined) break;
    ledger.delete(oldestKey);
  }
}

/** True only if `sessionId` was recorded by this runner AND its fingerprint matches exactly. */
export function canResume(ledger: Ledger, sessionId: string, fingerprint: string): boolean {
  const entry = ledger.get(sessionId);
  return entry !== undefined && entry.fingerprint === fingerprint;
}
