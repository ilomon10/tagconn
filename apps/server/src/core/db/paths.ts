const WIN_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * Comparable form of a path: NFC, `/` separators, no trailing slash. Windows drive paths also fold
 * `\` to `/`, drop trailing dots/spaces per segment (Windows ignores them) and are case-folded; on
 * POSIX a backslash is an ordinary filename character.
 */
export function normPath(p: string): string {
  const s = p.normalize('NFC');
  if (WIN_DRIVE.test(s)) {
    const segs = s.slice(3).split(/[\\/]+/).filter(Boolean).map((seg) => seg.replace(/[. ]+$/, ''));
    return `${s.slice(0, 2)}/${segs.join('/')}`.toLowerCase();
  }
  let n = s.replace(/\/{2,}/g, '/');
  while (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
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

/** Path segments below the root: POSIX `/a/b` is 2; Windows `C:\a\b` is 2 (the drive does not count). */
export function segmentCount(p: string): number {
  const n = normPath(p);
  return (WIN_DRIVE.test(n) ? n.slice(3) : n).split('/').filter(Boolean).length;
}

/** How a project's cwd was established: from a git toplevel, a CLAUDE_PROJECT_DIR fallback, or a payload cwd. */
export type RootSource = 'git' | 'dir' | 'cwd';

export interface FoldCandidate {
  cwd: string;
  archived: boolean;
  rootSource: RootSource | null;
}

/**
 * Only a confirmed git root, not archived and at least 3 deep (so `/home/u`, `~` and `/home` never
 * absorb anything), may absorb other floors.
 */
export const isFoldTarget = (p: FoldCandidate): boolean => p.rootSource === 'git' && !p.archived && segmentCount(p.cwd) >= 3;

/** The nearest fold target strictly containing `cwd`. */
export function nearestFoldTarget<T extends FoldCandidate>(cwd: string, candidates: readonly T[]): T | undefined {
  return nearestAncestor(cwd, candidates.filter(isFoldTarget));
}
