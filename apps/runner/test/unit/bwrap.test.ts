import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBwrapArgv, detectMergedUsr, guessTranscriptKey } from '../../src/bwrap.js';
import { mkSandbox, rmSandbox } from '../helpers.js';

describe('guessTranscriptKey', () => {
  it('replaces path separators and dots with dashes (observed Claude Code convention)', () => {
    expect(guessTranscriptKey('/home/ilomon/Projects/tagconn')).toBe('-home-ilomon-Projects-tagconn');
  });
});

describe('detectMergedUsr', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  it('reports merged (symlink) roots as such', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    mkdirSync(join(root, 'usr', 'bin'), { recursive: true });
    mkdirSync(join(root, 'usr', 'lib'), { recursive: true });
    symlinkSync(join(root, 'usr', 'bin'), join(root, 'bin'));
    symlinkSync(join(root, 'usr', 'lib'), join(root, 'lib'));
    // no /lib64 at all: treated as merged (nothing to --ro-bind)
    const detected = detectMergedUsr(root);
    expect(detected).toEqual({ bin: true, lib: true, lib64: true });
  });

  it('reports a real (non-merged) directory as needing --ro-bind', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    mkdirSync(join(root, 'bin'), { recursive: true }); // real dir, not a symlink into /usr
    mkdirSync(join(root, 'usr', 'lib'), { recursive: true });
    symlinkSync(join(root, 'usr', 'lib'), join(root, 'lib'));
    const detected = detectMergedUsr(root);
    expect(detected.bin).toBe(false);
    expect(detected.lib).toBe(true);
  });
});

describe('buildBwrapArgv', () => {
  const paths = {
    home: '/home/test',
    claudeBinDir: '/opt/claude/bin',
    claudeDir: '/home/test/.claude',
    transcriptDir: '/home/test/.claude/projects/-home-test-project',
    credentialsPath: '/home/test/.claude/.credentials.json',
    disposableClaudeJsonPath: '/state/runs/run-1/claude.json',
    bindDir: '/home/test/project',
    cwd: '/home/test/project',
  };

  it('includes the V12/V13 hardening flags: die-with-parent, new-session, unshare-pid/ipc/uts, cap-drop ALL', () => {
    const argv = buildBwrapArgv(paths, { bin: true, lib: true, lib64: true });
    for (const flag of ['--die-with-parent', '--new-session', '--unshare-pid', '--unshare-ipc', '--unshare-uts']) {
      expect(argv).toContain(flag);
    }
    expect(argv.join(' ')).toContain('--cap-drop ALL');
  });

  it('uses --symlink for a merged /usr and --ro-bind for a non-merged one', () => {
    const merged = buildBwrapArgv(paths, { bin: true, lib: true, lib64: true }).join(' ');
    expect(merged).toContain('--symlink usr/bin /bin');
    const nonMerged = buildBwrapArgv(paths, { bin: false, lib: false, lib64: false }).join(' ');
    expect(nonMerged).toContain('--ro-bind /bin /bin');
    expect(nonMerged).not.toContain('--symlink usr/bin /bin');
  });

  it('binds the transcript dir and credentials read-write, but the project read-only', () => {
    const argv = buildBwrapArgv(paths, { bin: true, lib: true, lib64: true });
    const idx = argv.indexOf('--bind');
    expect(idx).toBeGreaterThan(-1);
    expect(argv).toContain(paths.transcriptDir);
    expect(argv).toContain(paths.credentialsPath);
    // the project dir is --ro-bind'd, not --bind'd
    const roIdx = argv.indexOf('--ro-bind');
    expect(argv.slice(roIdx)).toContain(paths.bindDir);
  });

  it('binds the disposable ~/.claude.json copy onto $HOME/.claude.json', () => {
    const argv = buildBwrapArgv(paths, { bin: true, lib: true, lib64: true });
    const i = argv.indexOf(paths.disposableClaudeJsonPath);
    expect(argv[i + 1]).toBe('/home/test/.claude.json');
  });

  it('adds an extra --ro-bind for the docs dir only when provided (general scope)', () => {
    const without = buildBwrapArgv(paths, { bin: true, lib: true, lib64: true });
    expect(without).not.toContain('/state/receptionist-docs');
    const withDocs = buildBwrapArgv({ ...paths, docsDir: '/state/receptionist-docs' }, { bin: true, lib: true, lib64: true });
    expect(withDocs).toContain('/state/receptionist-docs');
  });

  it('ends with --chdir <cwd>, ready for the caller to append "-- <claude argv>"', () => {
    const argv = buildBwrapArgv(paths, { bin: true, lib: true, lib64: true });
    expect(argv.at(-2)).toBe('--chdir');
    expect(argv.at(-1)).toBe(paths.cwd);
  });
});
