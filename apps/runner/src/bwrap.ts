// bwrap sandbox for the Receptionist (docs/design/runner-and-helpdesk.md §4.3, V12/V13 verified).
// Network stays shared (the API and WebSearch need it); everything else is locked down: EROFS on the
// project and ~/.claude config, an empty $HOME, and --unshare-pid so the whole PID namespace dies with
// the run (V13: a setsid'd grandchild otherwise survives a plain process-group kill).

import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/** True = the path is a symlink (a "merged /usr" distro); false = a real directory needing --ro-bind. */
export interface MergedUsrDetection {
  bin: boolean;
  lib: boolean;
  lib64: boolean;
}

/** Probes /bin, /lib, /lib64: symlink (merged, use --symlink) vs. real directory (use --ro-bind). */
export function detectMergedUsr(root = ''): MergedUsrDetection {
  const isSymlink = (p: string): boolean => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return true; // doesn't exist: harmless to still --symlink it (bwrap tolerates a missing target)
    }
  };
  return {
    bin: isSymlink(join(root, '/bin')),
    lib: isSymlink(join(root, '/lib')),
    lib64: !existsSync(join(root, '/lib64')) || isSymlink(join(root, '/lib64')),
  };
}

/**
 * Best-effort guess at the transcript directory name Claude Code derives from an absolute cwd
 * (observed: '/' -> '-', e.g. "/home/user/project" -> "-home-user-project"). The runner verifies this
 * once at probe time against a real probe turn's transcript path and falls back to `none` (no bwrap)
 * on a mismatch, per §4.3.
 */
export function guessTranscriptKey(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export interface BwrapPaths {
  home: string;
  claudeBinDir: string;
  claudeDir: string; // realpath of $HOME/.claude
  transcriptDir: string; // $HOME/.claude/projects/<key>, created by the caller
  credentialsPath: string; // $HOME/.claude/.credentials.json
  disposableClaudeJsonPath: string; // <stateDir>/runs/<runId>/claude.json, created by the caller
  bindDir: string; // project realpath, or the receptionist neutral dir
  docsDir?: string; // stateDir/receptionist-docs, general scope only
  cwd: string;
}

/** Builds the bwrap argv up to (not including) `-- <claude argv>`, which the caller appends. */
export function buildBwrapArgv(paths: BwrapPaths, mergedUsr: MergedUsrDetection): string[] {
  const argv: string[] = [
    'bwrap',
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/usr',
    '/usr',
  ];

  if (mergedUsr.bin) argv.push('--symlink', 'usr/bin', '/bin', '--symlink', 'usr/bin', '/sbin');
  else argv.push('--ro-bind', '/bin', '/bin', '--ro-bind', '/sbin', '/sbin');
  if (mergedUsr.lib) argv.push('--symlink', 'usr/lib', '/lib');
  else argv.push('--ro-bind', '/lib', '/lib');
  if (mergedUsr.lib64) argv.push('--symlink', 'usr/lib', '/lib64');
  else argv.push('--ro-bind', '/lib64', '/lib64');

  argv.push(
    '--ro-bind',
    '/etc',
    '/etc',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    paths.home,
    '--setenv',
    'HOME',
    paths.home,
    '--ro-bind',
    paths.claudeBinDir,
    paths.claudeBinDir,
    '--ro-bind',
    paths.claudeDir,
    paths.claudeDir,
    '--bind',
    paths.transcriptDir,
    paths.transcriptDir,
    '--bind',
    paths.credentialsPath,
    paths.credentialsPath,
    '--bind',
    paths.disposableClaudeJsonPath,
    join(paths.home, '.claude.json'),
    '--ro-bind',
    paths.bindDir,
    paths.bindDir,
  );

  if (paths.docsDir) argv.push('--ro-bind', paths.docsDir, paths.docsDir);

  argv.push('--chdir', paths.cwd);
  return argv;
}
