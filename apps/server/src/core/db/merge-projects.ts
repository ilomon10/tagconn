import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import { isFoldTarget, isStrictlyUnder, nearestAncestor, normPath, type RootSource } from './paths.js';

export * from './paths.js';

interface ProjectRow {
  id: string;
  cwd: string;
  name: string;
  archived: boolean;
  rootSource: RootSource | null;
  lastActivityAt: number;
}

const readRows = (sqlite: Database.Database): ProjectRow[] =>
  (sqlite.prepare(`SELECT id, cwd, name, archived, root_source, last_activity_at FROM projects`).all() as {
    id: string;
    cwd: string;
    name: string;
    archived: number;
    root_source: RootSource | null;
    last_activity_at: number;
  }[]).map((r) => ({ id: r.id, cwd: r.cwd, name: r.name, archived: r.archived !== 0, rootSource: r.root_source, lastActivityAt: r.last_activity_at }));

/**
 * Non-git floors nested in `parent` whose nearest fold target is `parent` itself (a separate nested
 * git repo, and anything inside it, is never taken). Deepest first.
 */
function nestedChildren(rows: readonly ProjectRow[], parent: ProjectRow): ProjectRow[] {
  const targets = [...rows.filter((r) => r.id !== parent.id && isFoldTarget(r)), parent];
  return rows
    .filter((r) => r.id !== parent.id && r.rootSource !== 'git' && isStrictlyUnder(r.cwd, parent.cwd) && nearestAncestor(r.cwd, targets)?.id === parent.id)
    .sort((a, b) => normPath(b.cwd).length - normPath(a.cwd).length);
}

/** Floors that would merge into `parentId` (empty when it is unknown or not a fold target). */
export function pendingMergeChildren(sqlite: Database.Database, parentId: string): { id: string; name: string; cwd: string }[] {
  const rows = readRows(sqlite);
  const parent = rows.find((r) => r.id === parentId);
  if (!parent || !isFoldTarget(parent)) return [];
  return nestedChildren(rows, parent).map(({ id, name, cwd }) => ({ id, name, cwd }));
}

export interface MergeProjectsResult {
  merged: number;
  heroesMoved: number;
  heroesDropped: number;
  /** One entry per merged child, for the log. */
  pairs: { child: { id: string; name: string; cwd: string }; parent: { id: string; name: string; cwd: string } }[];
}

export interface MergeLimits {
  maxPerRole: number;
  maxPerProject: number;
}

const REPOINT_TABLES = ['sessions', 'agents', 'tasks', 'events', 'runs', 'receptionist_conversations'] as const;

/**
 * Merges every non-git floor nested in the confirmed git root `parentId` into it, in one transaction
 * (idempotent: nothing nested = no-op). Rows of the child move to the parent; the parent keeps its
 * name and layout (it is never archived here: an archived parent is not a fold target). Heroes take free
 * slots of the parent: a hero bound to a live agent is always kept (even over the caps); released
 * ones are dropped when `maxPerRole` or `maxPerProject` is reached. Settings overrides hold no
 * project ids, so nothing else references a floor.
 */
export function mergeNestedInto(sqlite: Database.Database, parentId: string, limits: MergeLimits): MergeProjectsResult {
  const result: MergeProjectsResult = { merged: 0, heroesMoved: 0, heroesDropped: 0, pairs: [] };
  sqlite.transaction(() => {
    const rows = readRows(sqlite);
    const parent = rows.find((r) => r.id === parentId);
    if (!parent || !isFoldTarget(parent)) return;
    for (const child of nestedChildren(rows, parent)) mergeOne(sqlite, child, parent, limits, result);
  })();
  return result;
}

function mergeOne(sqlite: Database.Database, child: ProjectRow, parent: ProjectRow, limits: MergeLimits, result: MergeProjectsResult): void {
  for (const t of REPOINT_TABLES) sqlite.prepare(`UPDATE ${t} SET project_id = ? WHERE project_id = ?`).run(parent.id, child.id);

  // One attribution import per project: the parent's wins.
  const parentImport = sqlite.prepare(`SELECT 1 FROM attribution_imports WHERE project_id = ?`).get(parent.id);
  if (parentImport) sqlite.prepare(`DELETE FROM attribution_imports WHERE project_id = ?`).run(child.id);
  else sqlite.prepare(`UPDATE attribution_imports SET project_id = ? WHERE project_id = ?`).run(parent.id, child.id);

  const parentHeroes = sqlite.prepare(`SELECT role, slot FROM heroes WHERE project_id = ?`).all(parent.id) as { role: string; slot: number }[];
  const taken = new Map<string, Set<number>>();
  for (const h of parentHeroes) taken.set(h.role, (taken.get(h.role) ?? new Set<number>()).add(h.slot));
  let total = parentHeroes.length;
  // Heroes bound to a live agent first: they are never dropped, so they claim their slots before the cap bites.
  const childHeroes = sqlite
    .prepare(
      `SELECT id, role, bound_agent_id IS NOT NULL AND released_at IS NULL AS live FROM heroes WHERE project_id = ? ORDER BY live DESC, role, slot`,
    )
    .all(child.id) as { id: string; role: string; live: number }[];
  for (const h of childHeroes) {
    const used = taken.get(h.role) ?? new Set<number>();
    if (!h.live && (used.size >= limits.maxPerRole || total >= limits.maxPerProject)) {
      sqlite.prepare(`UPDATE runs SET hero_id = NULL WHERE hero_id = ?`).run(h.id);
      sqlite.prepare(`DELETE FROM heroes WHERE id = ?`).run(h.id);
      result.heroesDropped++;
      continue;
    }
    let slot = 0;
    while (used.has(slot)) slot++;
    used.add(slot);
    taken.set(h.role, used);
    total++;
    sqlite.prepare(`UPDATE heroes SET project_id = ?, slot = ? WHERE id = ?`).run(parent.id, slot, h.id);
    result.heroesMoved++;
  }

  sqlite
    .prepare(`UPDATE projects SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?`)
    .run(child.lastActivityAt, parent.id);
  sqlite.prepare(`DELETE FROM projects WHERE id = ?`).run(child.id);
  result.merged++;
  result.pairs.push({
    child: { id: child.id, name: child.name, cwd: child.cwd },
    parent: { id: parent.id, name: parent.name, cwd: parent.cwd },
  });
}

export const MERGE_BACKUPS_KEPT = 3;

/**
 * `VACUUM INTO <db>.pre-merge-<timestamp>.bak` (a consistent copy even in WAL mode), then prune to the
 * newest {@link MERGE_BACKUPS_KEPT}. Returns the backup path, or undefined for an in-memory DB.
 * Mode 0600. Throws (after deleting any partial file) when the copy cannot be made, so the caller can skip the merge.
 */
export function backupBeforeMerge(sqlite: Database.Database, dbPath: string, now = Date.now()): string | undefined {
  if (dbPath === ':memory:' || dbPath === '') return undefined;
  mkdirSync(dirname(dbPath), { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, '');
  const target = `${dbPath}.pre-merge-${stamp}.bak`;
  const existed = existsSync(target);
  try {
    sqlite.prepare(`VACUUM INTO ?`).run(target);
    chmodSync(target, 0o600);
  } catch (err) {
    if (!existed) rmSync(target, { force: true }); // never leave a partial (or wrongly-permissioned) copy behind
    throw err;
  }
  const prefix = `${basename(dbPath)}.pre-merge-`;
  const old = readdirSync(dirname(dbPath))
    .filter((f) => f.startsWith(prefix) && f.endsWith('.bak'))
    .sort()
    .slice(0, -MERGE_BACKUPS_KEPT);
  for (const f of old) rmSync(join(dirname(dbPath), f), { force: true });
  return target;
}
