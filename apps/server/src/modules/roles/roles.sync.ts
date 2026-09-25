import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { type Role, RoleSchema } from '@tagconn/shared';
import YAML from 'yaml';

export const MANAGED_MARKER = '<!-- managed-by: tagconn -->';

export interface SyncResult {
  /** Files (re)written because their content changed. */
  written: string[];
  /** Managed files deleted because their role is gone, disabled or not synced. */
  removed: string[];
  /** Target files that exist without the marker (user-owned) and were left alone. */
  skipped: string[];
}

export const isValidRoleName = (name: string) => RoleSchema.shape.name.safeParse(name).success;

/** Claude subagent file: only Claude's frontmatter keys, the prompt, and the managed marker. */
export function renderAgentFile(role: Role): string {
  const fm: Record<string, string> = { name: role.name, description: role.description };
  if (role.tools !== null) fm.tools = role.tools.join(', ');
  if (role.model !== 'inherit') fm.model = role.model;
  const yaml = YAML.stringify(fm, { lineWidth: 0 });
  return `---\n${yaml}---\n\n${role.prompt.trim()}\n\n${MANAGED_MARKER}\n`;
}

/** True only for a plain regular file at `path` (not a symlink, directory, socket, etc.). */
const isRegularFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

const isManaged = (path: string) => {
  if (!isRegularFile(path)) return false; // never read through/treat a symlink as ours
  try {
    return readFileSync(path, 'utf8').includes(MANAGED_MARKER);
  } catch {
    return false;
  }
};

/** Refuses to sync into a directory that isn't clearly a dedicated, non-~/.claude "agents" dir. */
export function isSafeAgentsDir(agentsDir: string, claudeDir: string): boolean {
  const resolvedAgents = resolve(agentsDir);
  const resolvedClaude = resolve(claudeDir);
  return resolvedAgents !== resolvedClaude && basename(resolvedAgents) === 'agents';
}

function writeAtomic(path: string, content: string): void {
  // Unpredictable name + exclusive create: another process/symlink can't pre-stage the tmp file.
  const tmp = join(dirname(path), `.tagconn-${randomUUID()}.tmp`);
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  renameSync(tmp, path);
}

/** Mirrors enabled+syncToClaude roles into `dir`. Never touches files without the marker. */
export function syncRolesToDir(roles: Role[], dir: string): SyncResult {
  mkdirSync(dir, { recursive: true });
  const result: SyncResult = { written: [], removed: [], skipped: [] };
  const wanted = new Map<string, Role>();
  for (const role of roles) {
    // Names come from the DB, but re-check: the name becomes a file path.
    if (role.enabled && role.syncToClaude && isValidRoleName(role.name)) wanted.set(`${role.name}.md`, role);
  }

  for (const [file, role] of wanted) {
    const path = join(dir, file);
    const content = renderAgentFile(role);
    if (existsSync(path)) {
      if (!isManaged(path)) {
        result.skipped.push(file);
        continue;
      }
      if (readFileSync(path, 'utf8') === content) continue;
    }
    writeAtomic(path, content);
    result.written.push(file);
  }

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md') || wanted.has(file)) continue;
    const path = join(dir, file);
    if (isManaged(path)) {
      unlinkSync(path);
      result.removed.push(file);
    }
  }
  return result;
}
