import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
}

export const defaultFs: FsOps = {
  existsSync,
  readFileSync: (path, enc) => readFileSync(path, enc),
  writeFileSync: (path, data, opts) => writeFileSync(path, data, opts),
  renameSync,
  copyFileSync,
  rmSync: (path, opts) => rmSync(path, opts),
  mkdirSync: (path, opts) => void mkdirSync(path, opts),
};

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Atomic text write: a sibling temp file (exclusive create), then rename over the target. */
export function writeFileAtomic(path: string, text: string, fs: FsOps = defaultFs): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.${baseName(path)}.tagconn-tmp-${randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tmpPath, text, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmpPath, path);
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
