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

/** `%SystemRoot%\System32\<name>.exe`: an absolute system binary, so a hostile cwd or PATH entry can't stand in for it. */
export function systemBin(env: Record<string, string | undefined>, name: string): string {
  const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
  return `${root.replace(/[\\/]+$/, '')}\\System32\\${name}.exe`;
}

/** `DOMAIN\user` (display only; the grant and the check go by SID, see `currentWindowsUser`). */
export function windowsPrincipal(env: Record<string, string | undefined>): string {
  const user = env.USERNAME || userInfo().username;
  const domain = env.USERDOMAIN;
  return domain ? `${domain}\\${user}` : user;
}

export interface WindowsUser {
  sid: string;
  /** `DOMAIN\user` as whoami reports it (may be empty if the output could not be parsed that far). */
  name: string;
}

/** Strips NULs (UTF-16 output decoded as utf8) and a BOM, so a console codepage quirk can't hide the SID. */
function tolerantText(text: string): string {
  return text.replace(/\u0000/g, '').replace(/^\uFEFF/, '');
}

const SID_RE = /S-1-\d+(?:-\d+){1,14}/;

/** Parses `whoami /user /fo csv /nh` output: `"DOMAIN\user","S-1-5-21-..."`. null if no SID is found. */
export function parseWhoamiUser(output: string): WindowsUser | null {
  const text = tolerantText(output);
  const sid = SID_RE.exec(text)?.[0];
  if (!sid) return null;
  const name = /^\s*"([^"]*)"/.exec(text)?.[1]?.trim() ?? '';
  return { sid, name };
}

/** The current user's SID and account name from the absolute System32 whoami.exe; null on any failure. */
export function currentWindowsUser(env: Record<string, string | undefined>, exec: ExecFn): WindowsUser | null {
  const res = exec(systemBin(env, 'whoami'), ['/user', '/fo', 'csv', '/nh'], { timeoutMs: 15_000 });
  if (res.error || res.status !== 0) return null;
  return parseWhoamiUser(res.stdout);
}

function icaclsHint(path: string, sid: string | null, env: Record<string, string | undefined>): string {
  const who = sid ? `*${sid}:F` : '<your-user>:F';
  return `run: "${systemBin(env, 'icacls')}" "${path}" /inheritance:r /grant:r "${who}"  (secrets must not be readable by other users; find your SID with "${systemBin(env, 'whoami')}" /user)`;
}

const WHOAMI_FAIL = (env: Record<string, string | undefined>) =>
  `could not determine your Windows user SID (${systemBin(env, 'whoami')} /user failed)`;

/** Principals (left of `:(`) of the ACEs in `icacls <file>` output. The first line also carries the path. */
export function parseIcaclsPrincipals(output: string, path: string): string[] {
  const out: string[] = [];
  for (const raw of tolerantText(output).split(/\r?\n/)) {
    if (/^\s*Successfully processed/i.test(raw)) break;
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith(path)) line = line.slice(path.length).trim();
    const idx = line.indexOf(':(');
    if (idx > 0) out.push(line.slice(0, idx).trim());
  }
  return out;
}

/** An ACE is ours if it is the user's SID text, or the account name whoami reported (case-insensitive). */
function isCurrentUser(ace: string, user: WindowsUser): boolean {
  const a = ace.replace(/^\*/, '').toLowerCase();
  if (a === user.sid.toLowerCase()) return true;
  const n = user.name.toLowerCase();
  if (!n) return false;
  if (a === n) return true;
  // icacls may print the bare user name where whoami says DOMAIN\user.
  return !a.includes('\\') && a === (n.split('\\').pop() ?? '');
}

export type SecretVerification =
  | { ok: true }
  | { ok: false; kind: 'mode'; mode: string }
  | { ok: false; kind: 'acl'; detail: string; hint: string };

/**
 * POSIX: the mode must be exactly 600. win32: `icacls` (absolute System32 path) must list only the current
 * user, identified by the SID from whoami (no inherited ACEs, no Everyone/Users). Decision: SYSTEM and
 * Administrators are NOT tolerated. We never grant them (`/inheritance:r /grant:r` leaves the user alone),
 * and matching their localized names is unreliable, so an ACL that lists anyone else fails closed.
 * A failure to run whoami or icacls counts as a failed verification.
 */
export function verifySecretFile(path: string, opts: SecretOptions = {}): SecretVerification {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    const mode = statSync(path).mode & 0o777;
    return mode === 0o600 ? { ok: true } : { ok: false, kind: 'mode', mode: mode.toString(8) };
  }
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const user = currentWindowsUser(env, exec);
  const hint = icaclsHint(path, user?.sid ?? null, env);
  if (!user) return { ok: false, kind: 'acl', detail: WHOAMI_FAIL(env), hint };
  const res = exec(systemBin(env, 'icacls'), [path], { timeoutMs: 15_000 });
  if (res.error || res.status !== 0) {
    return { ok: false, kind: 'acl', detail: `icacls could not read the ACL (${res.error?.message ?? (res.stderr.trim() || `exit ${res.status}`)})`, hint };
  }
  const principals = parseIcaclsPrincipals(res.stdout, path);
  if (principals.length === 0) {
    return { ok: false, kind: 'acl', detail: 'icacls output had no access entries', hint };
  }
  const others = principals.filter((p) => !isCurrentUser(p, user));
  if (others.length > 0) {
    return { ok: false, kind: 'acl', detail: `also accessible by ${others.join(', ')}`, hint };
  }
  return { ok: true };
}

/** Restricts `path` to the current user: chmod 600 on POSIX, `icacls /inheritance:r /grant:r *<SID>:F` on win32. */
export function restrictSecretFile(path: string, opts: SecretOptions = {}): void {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    chmodSync(path, 0o600); // belt-and-suspenders: the create mode is still subject to umask.
    return;
  }
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? defaultExec;
  const user = currentWindowsUser(env, exec);
  if (!user) {
    throw new SecretFileError(`Could not restrict ${path} to your user (${WHOAMI_FAIL(env)}).`, path, icaclsHint(path, null, env));
  }
  // argv array, no shell: the path is never re-parsed. `*SID` grants by SID, immune to name/locale quirks.
  const res = exec(systemBin(env, 'icacls'), [path, '/inheritance:r', '/grant:r', `*${user.sid}:F`], { timeoutMs: 15_000 });
  if (res.error || res.status !== 0) {
    throw new SecretFileError(
      `Could not restrict ${path} to your user (${res.error?.message ?? (res.stderr.trim() || res.stdout.trim() || `icacls exit ${res.status}`)}).`,
      path,
      icaclsHint(path, user.sid, env),
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
