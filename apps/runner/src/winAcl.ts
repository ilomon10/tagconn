// win32 runner.json verification (M11 Wave 1 review M3, decision #28). Windows has no mode bits, so the runner
// checks with system tools (absolute %SystemRoot%\System32 paths, fixed cwd, timeout):
//  - `whoami /user` gives the current user's name and SID;
//  - `icacls <file>` lists the ACEs: every ACE granting a WRITE-class right must belong to the current user
//    (by name or SID), SYSTEM or BUILTIN\Administrators;
//  - `cmd /c dir /q` gives the owner: the current user or BUILTIN\Administrators.
// It fails closed: any output it cannot parse is an error with a hint, never a pass.

import { type Platform, systemRoot, win32SystemBin } from './platform.js';

const SYSTEM_NAMES = ['nt authority\\system'];
const ADMIN_NAMES = ['builtin\\administrators'];
const SYSTEM_SID = 's-1-5-18';
const ADMIN_SID = 's-1-5-32-544';

/** icacls permission tokens that let a principal change the file, its ACL or its owner, or delete it. */
const WRITE_RIGHTS = new Set(['F', 'M', 'W', 'WD', 'AD', 'D', 'DC', 'WDAC', 'WO', 'GA', 'GW']);

const HINT = 'fix it with: icacls <runner.json> /inheritance:r /grant:r "*<your SID>:(F)" (re-run `pnpm office:install`), or check that icacls.exe is in %SystemRoot%\\System32';

interface Identity {
  name: string;
  sid: string;
}

function normalizePrincipal(p: string): string {
  return p.trim().replace(/^\*/, '').toLowerCase();
}

function currentUser(plat: Platform): Identity | string {
  const r = plat.run(win32SystemBin(plat, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { timeoutMs: 10_000, cwd: systemRoot(plat.env) });
  const m = /^\s*"([^"]+)"\s*,\s*"(S-1-[0-9-]+)"/i.exec(r.stdout);
  if (r.status !== 0 || !m) return 'could not read the current user from whoami.exe';
  return { name: m[1]!.toLowerCase(), sid: m[2]!.toLowerCase() };
}

function isCurrentUser(principal: string, me: Identity): boolean {
  const p = normalizePrincipal(principal);
  return p === me.name || p === me.sid;
}

function isTrustedPrincipal(principal: string, me: Identity): boolean {
  const p = normalizePrincipal(principal);
  return isCurrentUser(p, me) || SYSTEM_NAMES.includes(p) || p === SYSTEM_SID || ADMIN_NAMES.includes(p) || p === ADMIN_SID;
}

/** Parses `icacls <file>` output into `{ principal, rights }` per ACE (DENY ACEs only ever restrict, so they are skipped). */
export function parseIcaclsAces(stdout: string, file: string): Array<{ principal: string; rights: string[] }> {
  const aces: Array<{ principal: string; rights: string[] }> = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line.toLowerCase().startsWith(file.toLowerCase())) line = line.slice(file.length).trim();
    if (!line || /^successfully processed/i.test(line)) continue;
    const m = /^(.+?):((?:\([^)]*\))+)\s*$/.exec(line);
    if (!m) continue;
    const groups = [...m[2]!.matchAll(/\(([^)]*)\)/g)].map((g) => g[1]!);
    const tokens = groups.flatMap((g) => g.split(',').map((t) => t.trim().toUpperCase()));
    if (tokens.includes('DENY')) continue;
    aces.push({ principal: m[1]!.trim(), rights: tokens });
  }
  return aces;
}

/** Parses the owner out of `dir /q` output for the line ending in `file`'s basename. */
export function parseDirOwner(stdout: string, baseName: string): string | undefined {
  const lower = baseName.toLowerCase();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.toLowerCase().endsWith(` ${lower}`)) continue;
    // "<date> <time> [AM|PM] <size> <owner> <name>": the owner is everything between the size column and the name.
    const rest = line.slice(0, line.length - baseName.length).trimEnd();
    const m = /^\S+\s+\S+(?:\s+[AP]M)?\s+[\d.,]+\s+(.+)$/i.exec(rest);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

/** Returns undefined when `file` is private to the current user, else a human-readable problem with a hint. */
export function verifyWindowsConfigAcl(file: string, plat: Platform): string | undefined {
  const me = currentUser(plat);
  if (typeof me === 'string') return `${me}; ${HINT}`;

  const acl = plat.run(win32SystemBin(plat, 'icacls.exe'), [file], { timeoutMs: 10_000, cwd: systemRoot(plat.env) });
  if (acl.status !== 0) return `icacls.exe failed on the file; ${HINT}`;
  const aces = parseIcaclsAces(acl.stdout, file);
  if (aces.length === 0) return `could not parse the icacls.exe output (fail closed); ${HINT}`;
  for (const ace of aces) {
    if (isTrustedPrincipal(ace.principal, me)) continue;
    if (ace.rights.some((r) => WRITE_RIGHTS.has(r))) return `"${ace.principal}" has write access; ${HINT}`;
  }
  if (!aces.some((a) => isCurrentUser(a.principal, me))) {
    // Only SYSTEM/Administrators listed: the runner could not even read it as the current user.
    return `the current user is not in the ACL; ${HINT}`;
  }

  const dir = plat.run(win32SystemBin(plat, 'cmd.exe'), ['/d', '/c', 'dir', '/q', '/a', file], { timeoutMs: 10_000, cwd: systemRoot(plat.env) });
  const owner = dir.status === 0 ? parseDirOwner(dir.stdout, plat.path.basename(file)) : undefined;
  if (!owner) return `could not determine the file owner (fail closed); ${HINT}`;
  const o = normalizePrincipal(owner);
  if (!(isCurrentUser(o, me) || ADMIN_NAMES.includes(o) || o === ADMIN_SID)) return `owner is "${owner}", not the current user; ${HINT}`;
  return undefined;
}
