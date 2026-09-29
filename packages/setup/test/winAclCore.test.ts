import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ACL_SCRIPT, isInheritOnly, isTrustedSid, isWriteClass, parseAclJson, SID_TRUSTED_INSTALLER, SWAP_MASK, WRITE_MASK, type AclInfo } from '../src/winAclCore.ts';

// ---- shared ACL fixtures (identical in apps/runner/test/unit/win32Hardening.test.ts and packages/setup/test/winAclCore.test.ts)
const ME = 'S-1-5-21-1-2-3-1001';
const ace = (sid: string, rights: number, o: { type?: string; inherited?: boolean; inh?: number; prop?: number } = {}) => ({
  sid, rights, type: o.type ?? 'Allow', inherited: o.inherited ?? false, inheritanceFlags: o.inh ?? 0, propagationFlags: o.prop ?? 0,
});
const FULL = 2032127; // FileSystemRights.FullControl
const MODIFY = 1245631;
const READ_EXEC = 1179817;
const aclJson = (aces: unknown[], owner: string | null = ME) => JSON.stringify({ owner, user: ME, aces });
/** English and German Windows print different names, but the SIDs (all this code sees) are the same. */
const ENGLISH = aclJson([ace(ME, FULL), ace('S-1-5-18', FULL), ace('S-1-5-32-544', FULL), ace('S-1-5-32-545', READ_EXEC, { inherited: true, inh: 3 })]);
const GERMAN = ENGLISH;
const UNTRANSLATABLE = aclJson([ace(ME, FULL), ace('S-1-5-21-9-9-9-1234', MODIFY)]);
const AUTH_USERS_WRITE = aclJson([ace(ME, FULL), ace('S-1-5-11', MODIFY, { inh: 3 })]);
const DENY_ONLY_OTHERS = aclJson([ace(ME, FULL), ace('S-1-1-0', FULL, { type: 'Deny' }), ace('S-1-5-11', READ_EXEC)]);
const INHERITED_WRITE = aclJson([ace(ME, FULL), ace('S-1-5-32-545', MODIFY, { inherited: true, inh: 3 })]);
const INHERIT_ONLY_WRITE = aclJson([ace(ME, FULL), ace('S-1-5-11', MODIFY, { inherited: true, inh: 3, prop: 2 })]);
const OWNED_BY_OTHER = aclJson([ace(ME, FULL)], 'S-1-5-21-1-2-3-1002');
// ---- end shared ACL fixtures

const ok = (json: string): AclInfo => {
  const r = parseAclJson(json);
  if (typeof r === 'string') throw new Error(r);
  return r;
};

describe('parseAclJson', () => {
  it('reads English and German fixtures the same (SIDs only)', () => {
    const a = ok(ENGLISH);
    expect(a.user).toBe(ME);
    expect(a.owner).toBe(ME);
    expect(a.aces.map((x) => x.sid)).toEqual([ME, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-32-545']);
    expect(ok(GERMAN)).toEqual(a);
    expect(a.aces[3]).toMatchObject({ inherited: true, inheritanceFlags: 3, propagationFlags: 0, rights: READ_EXEC });
  });

  it('strips BOM and NULs, tolerates leading noise, one ACE not wrapped in an array, string rights and 0/1 types', () => {
    const wide = '﻿' + ENGLISH.split('').join('\u0000');
    expect(ok(wide).aces).toHaveLength(4);
    expect(ok('WARNING: x\r\n' + ENGLISH + '\r\n').aces).toHaveLength(4);
    const one = ok(JSON.stringify({ owner: ME, user: ME, aces: { sid: ME, rights: 'Modify, Synchronize', type: 0, inherited: false, inheritanceFlags: 0, propagationFlags: 0 } }));
    expect(one.aces).toHaveLength(1);
    expect(one.aces[0]?.rights).toBe(0x1301bf | 0x100000);
    expect(ok(JSON.stringify({ owner: null, user: ME, aces: [{ sid: ME, rights: -1073741824, type: 'Deny' }] })).aces[0]).toMatchObject({ rights: 0xc0000000, type: 'Deny' });
    expect(ok(JSON.stringify({ owner: null, user: ME, aces: [] })).owner).toBeNull();
  });

  it('returns a problem string on anything it cannot read', () => {
    for (const bad of ['', 'nothing', '{"user":', '[]', '{"owner":"x"}', JSON.stringify({ user: ME, aces: [{ sid: ME, rights: 'Bogus', type: 'Allow' }] }), JSON.stringify({ user: ME, aces: [{ sid: '', rights: 1, type: 'Allow' }] }), JSON.stringify({ user: ME, aces: [{ sid: ME, rights: 1, type: 'Maybe' }] })]) {
      expect(typeof parseAclJson(bad), bad).toBe('string');
    }
  });
});

describe('classification', () => {
  const a = (json: string, i: number) => ok(json).aces[i]!;

  it('classifies by rights mask', () => {
    expect(isWriteClass(a(ENGLISH, 0))).toBe(true);
    expect(isWriteClass(a(ENGLISH, 3))).toBe(false); // read + execute
    expect(isWriteClass(a(AUTH_USERS_WRITE, 1))).toBe(true); // Authenticated Users: Modify
    for (const bit of [0x2, 0x4, 0x10, 0x40, 0x100, 0x10000, 0x40000, 0x80000, 0x40000000, 0x10000000]) expect(isWriteClass({ ...a(ENGLISH, 3), rights: bit }), String(bit)).toBe(true);
    for (const bit of [0x1, 0x8, 0x20, 0x80, 0x20000, 0x100000, 0x80000000, 0x20000000]) expect(isWriteClass({ ...a(ENGLISH, 3), rights: bit }), String(bit)).toBe(false);
    expect(WRITE_MASK & SWAP_MASK).toBe(SWAP_MASK);
  });

  it('a deny ACE is never write-class; inherited flags and inherit-only are exposed', () => {
    expect(isWriteClass(a(DENY_ONLY_OTHERS, 1))).toBe(false);
    expect(a(INHERITED_WRITE, 1).inherited).toBe(true);
    expect(isInheritOnly(a(INHERIT_ONLY_WRITE, 1))).toBe(true);
    expect(isInheritOnly(a(INHERITED_WRITE, 1))).toBe(false);
  });

  it('trusted SIDs: the user, SYSTEM, Administrators, and TrustedInstaller only when asked', () => {
    expect(isTrustedSid(ME, ME)).toBe(true);
    expect(isTrustedSid('s-1-5-18', ME)).toBe(true);
    expect(isTrustedSid('S-1-5-32-544', ME)).toBe(true);
    expect(isTrustedSid(SID_TRUSTED_INSTALLER, ME)).toBe(false);
    expect(isTrustedSid(SID_TRUSTED_INSTALLER, ME, { trustedInstaller: true })).toBe(true);
    expect(isTrustedSid('S-1-5-11', ME, { trustedInstaller: true })).toBe(false);
  });
});

describe('script', () => {
  it('has no double quotes and reads the path from the env', () => {
    expect(ACL_SCRIPT).not.toContain('"');
    expect(ACL_SCRIPT).toContain('$env:TAGCONN_ACL_PATH');
    expect(ACL_SCRIPT).toContain('Translate');
  });

  it('the runner copy of the core (apps/runner/src/winAcl.ts) is identical', () => {
    const start = 'export const SID_SYSTEM';
    const setup = readFileSync(fileURLToPath(new URL('../src/winAclCore.ts', import.meta.url)), 'utf8');
    const runner = readFileSync(fileURLToPath(new URL('../../../apps/runner/src/winAcl.ts', import.meta.url)), 'utf8');
    const a = setup.slice(setup.indexOf(start)).trim();
    const b = runner.slice(runner.indexOf(start), runner.indexOf('// ---- end ACL core')).trim();
    expect(b.length).toBeGreaterThan(500);
    expect(b).toBe(a);
  });
});
