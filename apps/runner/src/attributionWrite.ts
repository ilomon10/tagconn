// `attribution:write` handler (docs/design/runner-and-helpdesk.md §6.4 "Save (explicit only)"). The
// ONLY host-side file write a run initiates outside a spawned claude process. Runs inside
// `allowedProjectDirs` only, by realpath, never through a symlink, and never overwrites without
// explicit consent.

import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
  if (isSymlink(dirPath)) throw new AttributionWriteError('.tagconn is a symlink');
  if (isSymlink(filePath)) throw new AttributionWriteError('.tagconn/office.json is a symlink');

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

  mkdirSync(dirPath, { recursive: true });
  const tmp = join(dirPath, `.office.json.${process.pid}.tmp`);
  writeFileSync(tmp, cmd.content, { mode: 0o644 });
  renameSync(tmp, filePath);
  return { written: true, existed, relativePath: '.tagconn/office.json' };
}
