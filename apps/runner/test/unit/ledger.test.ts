import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canResume, computeFingerprint, loadLedger, recordSession, saveLedger } from '../../src/ledger.js';
import { mkSandbox, rmSandbox } from '../helpers.js';

describe('computeFingerprint', () => {
  it('is order-independent for tools and webFetchDomains (sorted internally)', () => {
    const a = computeFingerprint({ tools: ['Read', 'Grep'], mode: 'plan', restricted: true, safeMode: false });
    const b = computeFingerprint({ tools: ['Grep', 'Read'], mode: 'plan', restricted: true, safeMode: false });
    expect(a).toBe(b);
  });

  it('differs when tools, mode, restricted, safeMode or webFetchDomains differ', () => {
    const base = { tools: ['Read'], mode: 'plan', restricted: true, safeMode: false };
    const fp = computeFingerprint(base);
    expect(computeFingerprint({ ...base, tools: ['Read', 'Grep'] })).not.toBe(fp);
    expect(computeFingerprint({ ...base, mode: 'dontAsk' })).not.toBe(fp);
    expect(computeFingerprint({ ...base, restricted: false })).not.toBe(fp);
    expect(computeFingerprint({ ...base, safeMode: true })).not.toBe(fp);
    expect(computeFingerprint({ ...base, webFetchDomains: ['a.org'] })).not.toBe(fp);
  });
});

describe('ledger record / resume / persistence', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  it('canResume is true only for a recorded session id with the exact same fingerprint', () => {
    const ledger = loadLedger('/does/not/exist.json');
    recordSession(ledger, 'sess-1', 'fp-a', 100);
    expect(canResume(ledger, 'sess-1', 'fp-a')).toBe(true);
    expect(canResume(ledger, 'sess-1', 'fp-b')).toBe(false);
    expect(canResume(ledger, 'sess-unknown', 'fp-a')).toBe(false);
  });

  it('V15 fail-closed: resume with a changed fingerprint is refused even for a known session id', () => {
    const ledger = loadLedger('/does/not/exist.json');
    recordSession(ledger, 'sess-1', computeFingerprint({ tools: ['Read'], mode: 'plan', restricted: true, safeMode: false }), 100);
    const changed = computeFingerprint({ tools: ['Read', 'Grep'], mode: 'plan', restricted: true, safeMode: false });
    expect(canResume(ledger, 'sess-1', changed)).toBe(false);
  });

  it('evicts the oldest entry once maxSize is exceeded (bounded ledger)', () => {
    const ledger = loadLedger('/does/not/exist.json');
    recordSession(ledger, 'sess-1', 'fp', 2);
    recordSession(ledger, 'sess-2', 'fp', 2);
    recordSession(ledger, 'sess-3', 'fp', 2);
    expect(ledger.has('sess-1')).toBe(false);
    expect(ledger.has('sess-2')).toBe(true);
    expect(ledger.has('sess-3')).toBe(true);
  });

  it('a missing ledger file loads empty; save + load round-trips', () => {
    const dir = mkSandbox();
    sandboxes.push(dir);
    const path = join(dir, 'sub', 'session-ledger.json');
    const empty = loadLedger(path);
    expect(empty.size).toBe(0);

    recordSession(empty, 'sess-1', 'fp-a', 100);
    saveLedger(path, empty);

    const reloaded = loadLedger(path);
    expect(canResume(reloaded, 'sess-1', 'fp-a')).toBe(true);
  });

  it('a corrupt ledger file fails closed to an empty ledger rather than throwing', () => {
    const dir = mkSandbox();
    sandboxes.push(dir);
    const path = join(dir, 'session-ledger.json');
    writeFileSync(path, 'not json{{{');
    expect(loadLedger(path).size).toBe(0);
  });
});
