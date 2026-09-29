import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Runs a program with an argv array (never a shell). Injectable so tests can mock icacls, claude, docker... */
export type ExecFn = (cmd: string, args: string[], opts?: { timeoutMs?: number; cwd?: string }) => ExecResult;

export const defaultExec: ExecFn = (cmd, args, opts) => {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: opts?.timeoutMs ?? 10_000,
    cwd: opts?.cwd,
    windowsHide: true,
    shell: false,
  });
  return {
    status: res.status,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
    error: res.error,
  };
};

export interface SecretOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exec?: ExecFn;
}

/** A secret file could not be locked down to the current user. Callers must refuse to continue. */
export class SecretFileError extends Error {
  readonly code = 'secret_permissions';
  readonly path: string;
  readonly hint: string;
  constructor(message: string, path: string, hint: string) {
    super(`${message} Fix: ${hint}`);
    this.name = 'SecretFileError';
    this.path = path;
    this.hint = hint;
  }
}

/** `DOMAIN\user` for the icacls grant (falls back to the bare user name when USERDOMAIN is unset). */
export function windowsPrincipal(env: Record<string, string | undefined>): string {
  const user = env.USERNAME || userInfo().username;
  const domain = env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

function icaclsHint(path: string, principal: string): string {
  return `run: icacls "${path}" /inheritance:r /grant:r "${principal}:F"  (secrets must not be readable by other users)`;
}

/** Principals (left of `:(`) of the ACEs in `icacls <file>` output. The first line also carries the path. */
export function parseIcaclsPrincipals(output: string, path: string): string[] {
  const out: string[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (/^\s*Successfully processed/i.test(raw)) break;
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith(path)) line = line.slice(path.length).trim();
    const idx = line.indexOf(':(');
    if (idx > 0) out.push(line.slice(0, idx).trim());
  }
  return out;
}

function samePrincipal(ace: string, principal: string): boolean {
  const a = ace.toLowerCase();
  const p = principal.toLowerCase();
  if (a === p) return true;
  // icacls may print the bare user or COMPUTER\user where we granted DOMAIN\user.
  return a.split('\\').pop() === p.split('\\').pop();
}

export type SecretVerification =
  | { ok: true }
  | { ok: false; kind: 'mode'; mode: string }
  | { ok: false; kind: 'acl'; detail: string; hint: string };

/**
 * POSIX: the mode must be exactly 600. win32: `icacls` must list only the current user (no inherited
 * ACEs, no Everyone/Users). A failure to run icacls at all counts as a failed verification.
 */
export function verifySecretFile(path: string, opts: SecretOptions = {}): SecretVerification {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    return mode === 0o600 ? { ok: true } : { ok: false, kind: 'mode', mode: mode.toString(8) };
  }
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const principal = windowsPrincipal(env);
  const hint = icaclsHint(path, principal);
  const res = exec('icacls', [path]);
  if (res.error || res.status !== 0) {
    return { ok: false, kind: 'acl', detail: `icacls could not read the ACL (${res.error?.message ?? (res.stderr.trim() || `exit ${res.status}`)})`, hint };
  }
  const principals = parseIcaclsPrincipals(res.stdout, path);
  if (principals.length === 0) {
    return { ok: false, kind: 'acl', detail: 'icacls output had no access entries', hint };
  }
  const others = principals.filter((p) => !samePrincipal(p, principal));
  if (others.length > 0) {
    return { ok: false, kind: 'acl', detail: `also accessible by ${others.join(', ')}`, hint };
  }
  return { ok: true };
}

/** Restricts `path` to the current user: chmod 600 on POSIX, `icacls /inheritance:r /grant:r` on win32. */
export function restrictSecretFile(path: string, opts: SecretOptions = {}): void {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    chmodSync(path, 0o600); // belt-and-suspenders: the create mode is still subject to umask.
    return;
  }
  const principal = windowsPrincipal(opts.env ?? process.env);
  const exec = opts.exec ?? defaultExec;
  // argv array, no shell: the path and principal are never re-parsed.
  const res = exec('icacls', [path, '/inheritance:r', '/grant:r', `${principal}:F`]);
  if (res.error || res.status !== 0) {
    throw new SecretFileError(
      `Could not restrict ${path} to your user (${res.error?.message ?? (res.stderr.trim() || res.stdout.trim() || `icacls exit ${res.status}`)}).`,
      path,
      icaclsHint(path, principal),
    );
  }
}

/**
 * Writes a secret file atomically (SC4 L4): a temp file next to the target that is created empty and
 * locked down BEFORE the secret goes in, verified, then atomically renamed over the target - so a reader
 * (or a crashed install) never sees a partial or world-readable secret. Throws SecretFileError if the
 * permissions cannot be set or verified; the caller must then refuse to continue.
 */
export function writeSecretFile(path: string, content: string, opts: SecretOptions = {}): void {
  // Host path functions: these are real file operations. `platform` only selects chmod vs icacls.
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(path)}.tagconn-tmp-${randomBytes(6).toString('hex')}`);
  const fd = openSync(tmpPath, 'wx', 0o600);
  try {
    try {
      restrictSecretFile(tmpPath, opts);
      writeSync(fd, content, null, 'utf8');
    } finally {
      closeSync(fd);
    }
    const check = verifySecretFile(tmpPath, opts);
    if (!check.ok) {
      const why = check.kind === 'mode' ? `has mode ${check.mode}, expected 600` : check.detail;
      throw new SecretFileError(
        `Refusing to continue: ${path} ${why}.`,
        path,
        check.kind === 'mode' ? `chmod 600 ${path}` : check.hint,
      );
    }
    renameSync(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}
