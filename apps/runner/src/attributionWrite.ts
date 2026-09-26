// `attribution:write` handler (docs/design/runner-and-helpdesk.md §6.4 "Save (explicit only)"). The
// ONLY host-side file write a run initiates outside a spawned claude process. Runs inside
// `allowedProjectDirs` only, by realpath, never through a symlink, and never overwrites without
// explicit consent.

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { join, sep } from 'node:path';
import { AttributionProfileSchema, type AttributionWriteCommand, type AttributionWriteResult } from '@tagconn/shared';
import { isWithinAllowedDirs } from './trust.js';

export class AttributionWriteError extends Error {}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false; // doesn't exist: not a symlink
  }
}

export function writeAttributionProfile(cmd: AttributionWriteCommand, allowedProjectDirs: readonly string[]): AttributionWriteResult {
  let realDir: string;
  try {
    realDir = realpathSync(cmd.projectDir);
  } catch {
    throw new AttributionWriteError('project directory does not exist');
  }
  if (realDir === sep || realDir === homedir()) throw new AttributionWriteError('refusing to write to / or $HOME');
  if (!isWithinAllowedDirs(realDir, allowedProjectDirs)) throw new AttributionWriteError('project directory is not in allowedProjectDirs');
  if (!existsSync(join(realDir, '.git'))) throw new AttributionWriteError('project directory has no .git');

  const dirPath = join(realDir, '.tagconn');
  const filePath = join(dirPath, 'office.json');

  // Re-validate: the content this call carries is untrusted the moment it crosses a process boundary.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cmd.content);
  } catch {
    throw new AttributionWriteError('content is not valid JSON');
  }
  const parsed = AttributionProfileSchema.safeParse(parsedJson);
  if (!parsed.success) throw new AttributionWriteError(`content failed validation: ${parsed.error.message}`);

  const existed = existsSync(filePath);
  if (existed && !cmd.overwrite) {
    return { written: false, existed: true, relativePath: '.tagconn/office.json' };
  }

  // SC5 M3: mkdir FIRST, then lstat-verify right before writing (closes the check-then-create race a
  // "check isSymlink, then mkdir" ordering left open: an attacker could plant a symlink at dirPath in
  // that window). mkdirSync(recursive) silently no-ops if dirPath already exists as a symlink to a
  // directory (it follows symlinks to stat), so the lstat directly afterward — which does NOT follow
  // symlinks — is what actually catches that case.
  mkdirSync(dirPath, { recursive: true });
  const dirStat = lstatSync(dirPath);
  if (!dirStat.isDirectory()) throw new AttributionWriteError('.tagconn is not a real directory (symlink?)');
  if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid()) {
    throw new AttributionWriteError('.tagconn is not owned by the running user');
  }
  if (isSymlink(filePath)) throw new AttributionWriteError('.tagconn/office.json is a symlink');

  // Random tmp name (not the guessable pid-based one) opened with 'wx' (O_CREAT|O_EXCL): fails if
  // anything, including a pre-planted symlink, already sits at that exact path, instead of writing
  // through it. `rename()` never follows a symlink at the DESTINATION either way, but the write to the
  // tmp file itself is the step that mattered.
  const tmp = join(dirPath, `.office.json.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    writeSync(fd, cmd.content);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
  return { written: true, existed, relativePath: '.tagconn/office.json' };
}
