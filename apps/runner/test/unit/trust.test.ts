import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAllowedDir, isTrustedDir, isWithinAllowedDirs } from '../../src/trust.js';
import { mkSandbox, rmSandbox } from '../helpers.js';

describe('isWithinAllowedDirs', () => {
  it('accepts the root itself and anything strictly below it', () => {
    expect(isWithinAllowedDirs('/allowed', ['/allowed'])).toBe(true);
    expect(isWithinAllowedDirs('/allowed/sub', ['/allowed'])).toBe(true);
  });

  it('rejects a sibling that merely shares a string prefix (not a real path prefix)', () => {
    expect(isWithinAllowedDirs('/allowed-evil', ['/allowed'])).toBe(false);
  });

  it('never allows / or $HOME even if literally listed', () => {
    expect(isWithinAllowedDirs('/', ['/'])).toBe(false);
  });
});

describe('checkAllowedDir', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  it('resolves symlinks to their real path before checking containment', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    const real = join(root, 'real-project');
    mkdirSync(real, { recursive: true });
    const link = join(root, 'link-to-project');
    symlinkSync(real, link);
    const result = checkAllowedDir(link, [real]);
    expect(result.ok).toBe(true);
    expect(result.realDir).toBe(real);
  });

  it('fails closed for a directory that does not exist', () => {
    const result = checkAllowedDir('/definitely/not/here/xyz', ['/definitely']);
    expect(result).toEqual({ ok: false, failure: 'dir_not_allowed' });
  });

  it('rejects a dir outside every allowed root', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    const other = join(root, 'other');
    mkdirSync(other, { recursive: true });
    const result = checkAllowedDir(other, [join(root, 'allowed')]);
    expect(result.ok).toBe(false);
  });
});

describe('isTrustedDir', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  it('trusts an exact-realpath match in ~/.claude.json (hasTrustDialogAccepted)', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    const claudeJson = join(root, '.claude.json');
    writeFileSync(claudeJson, JSON.stringify({ projects: { '/home/x/proj': { hasTrustDialogAccepted: true } } }));
    expect(isTrustedDir('/home/x/proj', { claudeJsonPath: claudeJson, trustOverrideDirs: [] })).toBe(true);
  });

  it('does NOT inherit trust from a parent directory (fail-closed, exact realpath only)', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    const claudeJson = join(root, '.claude.json');
    writeFileSync(claudeJson, JSON.stringify({ projects: { '/home/x': { hasTrustDialogAccepted: true } } }));
    expect(isTrustedDir('/home/x/proj', { claudeJsonPath: claudeJson, trustOverrideDirs: [] })).toBe(false);
  });

  it('a fresh dir with no entry (as -p leaves it, per V14) is not trusted', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    const claudeJson = join(root, '.claude.json');
    writeFileSync(claudeJson, JSON.stringify({ projects: {} }));
    expect(isTrustedDir('/home/x/fresh', { claudeJsonPath: claudeJson, trustOverrideDirs: [] })).toBe(false);
  });

  it('trustOverrideDirs grants trust regardless of ~/.claude.json', () => {
    expect(isTrustedDir('/home/x/proj', { claudeJsonPath: '/does/not/exist.json', trustOverrideDirs: ['/home/x/proj'] })).toBe(true);
  });

  it('a missing or unparsable ~/.claude.json fails closed (never trusted)', () => {
    expect(isTrustedDir('/home/x/proj', { claudeJsonPath: '/does/not/exist.json', trustOverrideDirs: [] })).toBe(false);
  });

  it('hasTrustDialogAccepted: false is not trusted', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    const claudeJson = join(root, '.claude.json');
    writeFileSync(claudeJson, JSON.stringify({ projects: { '/home/x/proj': { hasTrustDialogAccepted: false } } }));
    expect(isTrustedDir('/home/x/proj', { claudeJsonPath: claudeJson, trustOverrideDirs: [] })).toBe(false);
  });
});
