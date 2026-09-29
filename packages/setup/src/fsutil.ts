import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { touch, type SetupContext } from './context.ts';

/** The fs calls the settings merge makes, so tests can inject a failure mid-write. */
export interface FsOps {
  existsSync: (path: string) => boolean;
  readFileSync: (path: string, enc: 'utf8') => string;
  writeFileSync: (path: string, data: string, opts: { encoding: 'utf8'; flag: 'wx' }) => void;
  renameSync: (from: string, to: string) => void;
  copyFileSync: (from: string, to: string) => void;
  rmSync: (path: string, opts: { force: true }) => void;
  mkdirSync: (path: string, opts: { recursive: true }) => void;
  /** Resolves symlinks, so a symlinked file is written through and stays a symlink. Optional for test fakes. */
  realpathSync?: (path: string) => string;
  /** The file's permission bits (POSIX), copied onto the replacement. Optional for test fakes. */
  modeOf?: (path: string) => number;
  chmodSync?: (path: string, mode: number) => void;
}

export const defaultFs: FsOps = {
  existsSync,
  readFileSync: (path, enc) => readFileSync(path, enc),
  writeFileSync: (path, data, opts) => writeFileSync(path, data, opts),
  renameSync,
  copyFileSync,
  rmSync: (path, opts) => rmSync(path, opts),
  mkdirSync: (path, opts) => void mkdirSync(path, opts),
  realpathSync: (path) => realpathSync(path),
  modeOf: (path) => statSync(path).mode & 0o7777,
  chmodSync,
};

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The path to actually replace: the symlink's target if `path` is a symlink (so it stays a symlink). */
export function writeTargetOf(path: string, fs: FsOps = defaultFs): string {
  if (!fs.existsSync(path)) return path;
  try {
    return fs.realpathSync ? fs.realpathSync(path) : path;
  } catch {
    return path;
  }
}

/**
 * Atomic text write: a sibling temp file (exclusive create), then rename over the target. Writes through
 * realpath (a symlinked file stays a symlink) and copies an existing file's permission bits onto the
 * replacement (POSIX). On win32 the replacement gets the folder's inherited ACL, not the old file's custom
 * ACL; settings.json normally has none.
 */
export function writeFileAtomic(path: string, text: string, fs: FsOps = defaultFs): void {
  const target = writeTargetOf(path, fs);
  fs.mkdirSync(dirname(target), { recursive: true });
  const tmpPath = join(dirname(target), `.${baseName(target)}.tagconn-tmp-${randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmpPath, text, { encoding: 'utf8', flag: 'wx' });
    if (fs.modeOf && fs.chmodSync && fs.existsSync(target) && process.platform !== 'win32') {
      fs.chmodSync(tmpPath, fs.modeOf(target));
    }
    fs.renameSync(tmpPath, target);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best effort; the original error is what matters
    }
    throw err;
  }
}

/** Atomic JSON write; a dry run only logs. */
export function writeJsonAtomic(ctx: SetupContext, path: string, value: unknown, fs: FsOps = defaultFs): void {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would write ${path}`);
    return;
  }
  writeFileAtomic(path, text, fs);
  touch(ctx, path);
}

export function ensureDir(ctx: SetupContext, path: string): void {
  if (ctx.dryRun) return;
  mkdirSync(path, { recursive: true });
}

/**
 * Ensures the config dir exists, mode 700 (POSIX), and not dry-run. SC4 INFO: never chmods a directory we
 * didn't just create unless it's literally named "tagconn" - so a misdirected `--config-dir ~` (or any
 * other pre-existing directory the user pointed us at) doesn't get its permissions silently changed.
 * On win32 the per-file ACLs (secrets.ts) protect the secrets instead.
 */
export function ensureConfigDir(ctx: SetupContext, configDir: string): string {
  if (ctx.dryRun) return configDir;
  const existedBefore = existsSync(configDir);
  mkdirSync(configDir, { recursive: true });
  if (ctx.platform !== 'win32' && (!existedBefore || baseName(configDir) === 'tagconn')) {
    chmodSync(configDir, 0o700);
  }
  return configDir;
}
