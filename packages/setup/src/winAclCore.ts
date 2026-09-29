// Locale-independent Windows ACL reading (M11 11.5): ACEs and owner as SIDs from PowerShell Get-Acl, classified by rights mask.
// Pure (no process spawning). A copy of this code lives in apps/runner/src/winAcl.ts (the runner cannot import setup);
// packages/setup/test/winAclCore.test.ts checks the two stay identical.

export const SID_SYSTEM = 'S-1-5-18';
export const SID_ADMINISTRATORS = 'S-1-5-32-544';
export const SID_TRUSTED_INSTALLER = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';

/** PowerShell script (single line, no double quotes: it travels on argv). The path comes from $env:TAGCONN_ACL_PATH. */
export const ACL_SCRIPT_LINES: readonly string[] = [
  `$ErrorActionPreference='Stop';`,
  `$t=[System.Security.Principal.SecurityIdentifier];`,
  `function Get-TcSid($i){try{$i.Translate($t).Value}catch{[string]$i.Value}};`,
  `$a=Get-Acl -LiteralPath $env:TAGCONN_ACL_PATH;`,
  `$o=$null;try{$o=$a.GetOwner($t).Value}catch{};`,
  `$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;`,
  `$x=@($a.Access|ForEach-Object{[pscustomobject]@{sid=(Get-TcSid $_.IdentityReference);rights=[int]$_.FileSystemRights;type=[string]$_.AccessControlType;inherited=[bool]$_.IsInherited;inheritanceFlags=[int]$_.InheritanceFlags;propagationFlags=[int]$_.PropagationFlags}});`,
  `[pscustomobject]@{owner=$o;user=$u;aces=$x}|ConvertTo-Json -Compress -Depth 4`,
];
export const ACL_SCRIPT = ACL_SCRIPT_LINES.join(' ');

export interface AclAce {
  sid: string;
  /** FileSystemRights as an unsigned 32-bit mask. */
  rights: number;
  type: 'Allow' | 'Deny';
  inherited: boolean;
  inheritanceFlags: number;
  propagationFlags: number;
}

export interface AclInfo {
  /** Owner SID; null when PowerShell could not translate it. */
  owner: string | null;
  /** The current user's SID. */
  user: string;
  aces: AclAce[];
}

const GENERIC_ALL = 0x10000000;
const GENERIC_WRITE = 0x40000000;
const FSR_NAMES: Record<string, number> = {
  readdata: 0x1, listdirectory: 0x1, writedata: 0x2, createfiles: 0x2, appenddata: 0x4, createdirectories: 0x4,
  readextendedattributes: 0x8, writeextendedattributes: 0x10, executefile: 0x20, traverse: 0x20,
  deletesubdirectoriesandfiles: 0x40, readattributes: 0x80, writeattributes: 0x100, delete: 0x10000,
  readpermissions: 0x20000, changepermissions: 0x40000, takeownership: 0x80000, synchronize: 0x100000,
  read: 0x20089, write: 0x116, readandexecute: 0x200a9, modify: 0x1301bf, fullcontrol: 0x1f01ff,
};
/** Rights that let a principal change the object or replace it: WriteData/AppendData/WriteEA/WriteAttributes/Delete/DeleteChild/ChangePermissions/TakeOwnership (+ generic all/write). */
export const WRITE_MASK = (0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | GENERIC_ALL | GENERIC_WRITE) >>> 0;
/** The subset that lets a principal swap a whole tree: Delete/DeleteChild/ChangePermissions/TakeOwnership (+ generic all/write). */
export const SWAP_MASK = (0x40 | 0x10000 | 0x40000 | 0x80000 | GENERIC_ALL | GENERIC_WRITE) >>> 0;
const INHERIT_ONLY = 2;

export function hasRights(rights: number, mask: number): boolean {
  return ((rights & mask) >>> 0) !== 0;
}

/** True when the ACE grants a write-class right (`mask` narrows it, e.g. SWAP_MASK). */
export function isWriteClass(ace: AclAce, mask: number = WRITE_MASK): boolean {
  return ace.type === 'Allow' && hasRights(ace.rights, mask);
}

/** An inherit-only ACE does not apply to the object it sits on, only to its children. */
export function isInheritOnly(ace: AclAce): boolean {
  return (ace.propagationFlags & INHERIT_ONLY) !== 0;
}

export function isTrustedSid(sid: string, user: string, opts: { trustedInstaller?: boolean } = {}): boolean {
  const s = sid.toUpperCase();
  return s === user.toUpperCase() || s === SID_SYSTEM || s === SID_ADMINISTRATORS || (opts.trustedInstaller === true && s === SID_TRUSTED_INSTALLER);
}

function parseRights(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v >>> 0;
  if (typeof v !== 'string' || v.trim() === '') return null;
  if (/^-?\d+$/.test(v.trim())) return Number(v.trim()) >>> 0;
  let mask = 0;
  for (const part of v.split(',')) {
    const bit = FSR_NAMES[part.trim().toLowerCase()];
    if (bit === undefined) return null;
    mask |= bit;
  }
  return mask >>> 0;
}

function parseFlag(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0;
}

/** Parses the script's JSON output. A string result is a problem description (callers fail closed). */
export function parseAclJson(stdout: string): AclInfo | string {
  const text = stdout.replace(/[\u0000﻿]/g, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return 'PowerShell printed no ACL JSON';
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return 'PowerShell printed unparseable ACL JSON';
  }
  if (typeof raw !== 'object' || raw === null) return 'PowerShell printed unexpected ACL JSON';
  const r = raw as Record<string, unknown>;
  if (typeof r.user !== 'string' || !/^S-1-\d+(?:-\d+)+$/i.test(r.user)) return 'PowerShell did not report the current user SID';
  const list = Array.isArray(r.aces) ? r.aces : r.aces && typeof r.aces === 'object' ? [r.aces] : [];
  const aces: AclAce[] = [];
  for (const item of list) {
    const a = (item ?? {}) as Record<string, unknown>;
    const rights = parseRights(a.rights);
    const type = a.type === 'Allow' || a.type === 0 ? 'Allow' : a.type === 'Deny' || a.type === 1 ? 'Deny' : null;
    if (typeof a.sid !== 'string' || a.sid.trim() === '' || rights === null || type === null) return 'PowerShell printed an ACE that could not be read';
    aces.push({ sid: a.sid.trim(), rights, type, inherited: a.inherited === true, inheritanceFlags: parseFlag(a.inheritanceFlags), propagationFlags: parseFlag(a.propagationFlags) });
  }
  return { owner: typeof r.owner === 'string' && r.owner.trim() !== '' ? r.owner.trim() : null, user: r.user, aces };
}
