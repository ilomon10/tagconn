import type Database from 'better-sqlite3';

/** Comparable form of a path: `/` separators, no trailing slash, case-folded for Windows drive paths. */
function normPath(p: string): string {
  const win = /^[A-Za-z]:[\\/]/.test(p);
  let n = p.replace(/[\\/]+/g, '/');
  while (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return win ? n.toLowerCase() : n;
}

/** True when `child` lies strictly inside `parent` (path-prefix at a separator; POSIX and Windows style). */
export function isStrictlyUnder(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  if (p === '/' || c === p) return false;
  return c.startsWith(`${p}/`);
}

/** The nearest (longest cwd) project among `candidates` that strictly contains `cwd`, if any. */
export function nearestAncestor<T extends { cwd: string }>(cwd: string, candidates: readonly T[]): T | undefined {
  let best: T | undefined;
  for (const c of candidates) {
    if (isStrictlyUnder(cwd, c.cwd) && (!best || normPath(c.cwd).length > normPath(best.cwd).length)) best = c;
  }
  return best;
}

interface ProjectRow {
  id: string;
  cwd: string;
  last_activity_at: number;
}

export interface MergeProjectsResult {
  merged: number;
  heroesMoved: number;
  heroesDropped: number;
}

const REPOINT_TABLES = ['sessions', 'agents', 'tasks', 'events', 'runs', 'receptionist_conversations'] as const;

/**
 * M12 boot migration (idempotent): a project whose cwd lies strictly under another project's cwd was
 * created by an agent that `cd`'d into a subdirectory. Merge it into its nearest ancestor: every row
 * of the child moves to the parent, heroes take free slots of the parent (overflow beyond
 * `maxPerRole` is dropped), the parent keeps its name and layout, and the child is deleted.
 */
export function mergeNestedProjects(sqlite: Database.Database, opts: { maxPerRole?: number } = {}): MergeProjectsResult {
  const maxPerRole = opts.maxPerRole ?? 64;
  const result: MergeProjectsResult = { merged: 0, heroesMoved: 0, heroesDropped: 0 };
  sqlite.transaction(() => {
    for (;;) {
      const rows = sqlite.prepare(`SELECT id, cwd, last_activity_at FROM projects`).all() as ProjectRow[];
      // Deepest child first, so a chain A > B > C collapses C into B, then B into A.
      const ordered = [...rows].sort((a, b) => normPath(b.cwd).length - normPath(a.cwd).length);
      let child: ProjectRow | undefined;
      let parent: ProjectRow | undefined;
      for (const r of ordered) {
        parent = nearestAncestor(r.cwd, rows);
        if (parent) {
          child = r;
          break;
        }
      }
      if (!child || !parent) break;
      mergeOne(sqlite, child, parent, maxPerRole, result);
    }
  })();
  return result;
}

function mergeOne(sqlite: Database.Database, child: ProjectRow, parent: ProjectRow, maxPerRole: number, result: MergeProjectsResult): void {
  for (const t of REPOINT_TABLES) sqlite.prepare(`UPDATE ${t} SET project_id = ? WHERE project_id = ?`).run(parent.id, child.id);

  // One attribution import per project: the parent's wins.
  const parentImport = sqlite.prepare(`SELECT 1 FROM attribution_imports WHERE project_id = ?`).get(parent.id);
  if (parentImport) sqlite.prepare(`DELETE FROM attribution_imports WHERE project_id = ?`).run(child.id);
  else sqlite.prepare(`UPDATE attribution_imports SET project_id = ? WHERE project_id = ?`).run(parent.id, child.id);

  const taken = new Map<string, Set<number>>();
  for (const h of sqlite.prepare(`SELECT role, slot FROM heroes WHERE project_id = ?`).all(parent.id) as { role: string; slot: number }[]) {
    const set = taken.get(h.role) ?? new Set<number>();
    set.add(h.slot);
    taken.set(h.role, set);
  }
  const childHeroes = sqlite
    .prepare(`SELECT id, role, slot FROM heroes WHERE project_id = ? ORDER BY role, slot`)
    .all(child.id) as { id: string; role: string; slot: number }[];
  for (const h of childHeroes) {
    const used = taken.get(h.role) ?? new Set<number>();
    let slot = 0;
    while (used.has(slot)) slot++;
    if (slot >= maxPerRole) {
      sqlite.prepare(`DELETE FROM heroes WHERE id = ?`).run(h.id);
      result.heroesDropped++;
      continue;
    }
    used.add(slot);
    taken.set(h.role, used);
    sqlite.prepare(`UPDATE heroes SET project_id = ?, slot = ? WHERE id = ?`).run(parent.id, slot, h.id);
    result.heroesMoved++;
  }

  sqlite
    .prepare(`UPDATE projects SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?`)
    .run(child.last_activity_at, parent.id);
  sqlite.prepare(`DELETE FROM projects WHERE id = ?`).run(child.id);
  result.merged++;
}
