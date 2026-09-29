// win32 runner.json verification (M11 Wave 1 review M3, decision #28). Windows has no mode bits, so the runner
// checks with system tools (absolute %SystemRoot%\System32 paths, fixed cwd, timeout):
//  - `whoami /user` gives the current user's name and SID;
//  - `icacls <file>` lists the ACEs: every ACE granting a WRITE-class right must belong to the current user
//    (by name or SID), SYSTEM or BUILTIN\Administrators;
//  - PowerShell `(Get-Acl -LiteralPath $env:TAGCONN_ACL_PATH).Owner` gives the owner (the path travels in the env, never on
//    a command line, and no cmd.exe re-parsing is involved): the current user or BUILTIN\Administrators.
//  - N10: rights are checked as an ALLOW-list of read-only tokens; anything else from a non-owner principal is a write.
// It fails closed: any output it cannot parse is an error with a hint, never a pass.

import { type Platform, systemRoot, win32SystemBin } from './platform.js';

const SYSTEM_NAMES = ['nt authority\\system'];
const ADMIN_NAMES = ['builtin\\administrators'];
const SYSTEM_SID = 's-1-5-18';
const ADMIN_SID = 's-1-5-32-544';

/** icacls rights a non-owner principal may hold: read-only tokens plus inheritance flags. Anything else counts as a write. */
const READ_ONLY_TOKENS = new Set(['R', 'RX', 'RD', 'REA', 'RA', 'RC', 'S', 'X', 'GR', 'GE', 'N', 'OI', 'CI', 'IO', 'NP', 'I']);

/** Strips NULs (UTF-16 read as UTF-8) and BOMs helper output can carry. */
function clean(text: string): string {
  return text.replace(/[\u0000\uFEFF]/g, '');
}

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
  const m = /^\s*"([^"]+)"\s*,\s*"(S-1-[0-9-]+)"/i.exec(clean(r.stdout));
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

/** Returns undefined when `file` is private to the current user, else a human-readable problem with a hint. */
export function verifyWindowsConfigAcl(file: string, plat: Platform): string | undefined {
  const me = currentUser(plat);
  if (typeof me === 'string') return `${me}; ${HINT}`;

  const acl = plat.run(win32SystemBin(plat, 'icacls.exe'), [file], { timeoutMs: 10_000, cwd: systemRoot(plat.env) });
  if (acl.status !== 0) return `icacls.exe failed on the file; ${HINT}`;
  const aces = parseIcaclsAces(clean(acl.stdout), file);
  if (aces.length === 0) return `could not parse the icacls.exe output (fail closed); ${HINT}`;
  for (const ace of aces) {
    if (isTrustedPrincipal(ace.principal, me)) continue;
    if (ace.rights.some((r) => !READ_ONLY_TOKENS.has(r))) return `"${ace.principal}" has write access; ${HINT}`;
  }
  if (!aces.some((a) => isCurrentUser(a.principal, me))) {
    // Only SYSTEM/Administrators listed: the runner could not even read it as the current user.
    return `the current user is not in the ACL; ${HINT}`;
  }

  const ps = plat.path.join(systemRoot(plat.env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const own = plat.run(ps, ['-NoProfile', '-NonInteractive', '-Command', '(Get-Acl -LiteralPath $env:TAGCONN_ACL_PATH).Owner'], {
    timeoutMs: 10_000,
    cwd: systemRoot(plat.env),
    env: { TAGCONN_ACL_PATH: file },
  });
  const ownerLines = clean(own.stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const owner = own.status === 0 && ownerLines.length === 1 ? ownerLines[0] : undefined;
  if (!owner) return `could not determine the file owner (fail closed); ${HINT}`;
  const o = normalizePrincipal(owner);
  if (!(isCurrentUser(o, me) || ADMIN_NAMES.includes(o) || o === ADMIN_SID)) return `owner is "${owner}", not the current user; ${HINT}`;
  return undefined;
}
