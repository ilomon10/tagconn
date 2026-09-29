import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { currentWindowsUser, defaultExec, systemBin, type ExecFn } from '@tagconn/setup';

export interface DataDirOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exec?: ExecFn;
}

/**
 * N8: creates the data folder (SQLite DB) so only the current user can use it: 0700 on POSIX, a user-only ACL
 * (`icacls /inheritance:r /grant:r *<SID>:(OI)(CI)F`, absolute System32 binary, SID grant) on win32. Only a folder
 * WE create is restricted: an existing one (a folder the user picked) keeps its permissions. Throws when it cannot
 * be created or locked down.
 */
export function ensureDataDir(dir: string, opts: DataDirOptions = {}): void {
  if (existsSync(dir)) return;
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') {
    chmodSync(dir, 0o700); // mkdir's mode is masked by the umask
    return;
  }
  const exec = opts.exec ?? defaultExec;
  const user = currentWindowsUser(env, exec);
  if (!user) throw new Error(`Could not restrict ${dir} to your user (whoami failed).`);
  const res = exec(systemBin(env, 'icacls'), [dir, '/inheritance:r', '/grant:r', `*${user.sid}:(OI)(CI)F`], { timeoutMs: 15_000 });
  if (res.error || res.status !== 0) {
    throw new Error(`Could not restrict ${dir} to your user (${res.error?.message ?? (res.stderr.trim() || `icacls exit ${res.status}`)}).`);
  }
}
