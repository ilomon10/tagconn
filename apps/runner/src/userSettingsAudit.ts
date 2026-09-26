// SC5 H2: quests and the Receptionist always run with `--setting-sources=user` (V14), which means the
// user's OWN `~/.claude/settings.json` permission rules stay in effect on top of whatever the runner
// itself passes as --tools/--allowedTools/--disallowedTools. A permissive rule there (a bare Bash or
// WebFetch allow, an mcp__ allow, extra `additionalDirectories`, or a permissive `defaultMode`) widens
// every quest and Receptionist turn beyond what runner.json's own policy intends.
//
// This is ADVISORY only: the runner's own exact --tools list, --disallowedTools backstop (Bash is
// always hard-denied unless a local rule granted it — toolPolicy.ts) and the Receptionist's --restricted
// / bwrap layers remain the actual enforced boundary regardless of what this finds. It exists so the
// operator finds out at all (logged at startup; `office:doctor`, owned by scripts/, surfaces the same
// check for a human to read without tailing runner logs).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface UserSettingsAudit {
  path: string;
  /** Human-readable findings, e.g. "a Bash allow rule". Empty when nothing risky was found. */
  findings: string[];
  /** True when a bare (unscoped) WebFetch allow rule is present: the Receptionist's general-scope
   *  WebFetch variant drops WebFetch for the turn rather than trust the CLI to still confine it. */
  bareWebFetchAllowed: boolean;
}

interface ClaudeSettingsPermissions {
  allow?: unknown;
  additionalDirectories?: unknown;
  defaultMode?: unknown;
}

interface ClaudeSettingsShape {
  permissions?: ClaudeSettingsPermissions;
}

function isBashAllowRule(rule: string): boolean {
  return rule === 'Bash' || rule.startsWith('Bash(');
}

function isWebFetchAllowRule(rule: string): boolean {
  return rule === 'WebFetch' || rule.startsWith('WebFetch(');
}

function isBareWebFetchAllowRule(rule: string): boolean {
  return rule === 'WebFetch' || rule === 'WebFetch()';
}

function isMcpAllowRule(rule: string): boolean {
  return rule.startsWith('mcp__');
}

/**
 * Reads and audits the user's own `~/.claude/settings.json` (never throws: a missing or unreadable
 * file, or one that fails to parse as JSON, is simply "nothing to report" — it is not this runner's
 * job to validate the user's own CLI settings, only to flag the specific risky shapes above).
 */
export function auditUserSettings(settingsPath: string = join(homedir(), '.claude', 'settings.json')): UserSettingsAudit {
  const empty: UserSettingsAudit = { path: settingsPath, findings: [], bareWebFetchAllowed: false };
  if (!existsSync(settingsPath)) return empty;

  let parsed: ClaudeSettingsShape;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as ClaudeSettingsShape;
  } catch {
    return empty;
  }

  const allow = Array.isArray(parsed.permissions?.allow) ? (parsed.permissions.allow as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  const additionalDirectories = Array.isArray(parsed.permissions?.additionalDirectories) ? parsed.permissions.additionalDirectories : [];
  const defaultMode = typeof parsed.permissions?.defaultMode === 'string' ? parsed.permissions.defaultMode : undefined;

  const findings: string[] = [];
  if (allow.some(isBashAllowRule)) findings.push('a Bash allow rule');
  if (allow.some(isWebFetchAllowRule)) findings.push('a WebFetch allow rule');
  if (allow.some(isMcpAllowRule)) findings.push('an mcp__ allow rule');
  if (additionalDirectories.length > 0) findings.push('additionalDirectories');
  if (defaultMode && defaultMode !== 'default') findings.push(`defaultMode=${defaultMode}`);

  return { path: settingsPath, findings, bareWebFetchAllowed: allow.some(isBareWebFetchAllowRule) };
}
