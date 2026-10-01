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

/** A home dir or a direct child of one (`/home/u/code`, `/Users/u/Projects`, `/root/x`, `C:\\Users\\u\\code`): a container, never a repo to absorb floors. */
const HOME_OR_CHILD = [/^\/home\/[^/]+(\/[^/]+)?$/, /^\/users\/[^/]+(\/[^/]+)?$/i, /^\/root(\/[^/]+)?$/, /^[a-z]:\/users\/[^/]+(\/[^/]+)?$/];

/**
 * Only a confirmed git root, not archived, that is not a home dir or a direct child of one (`~`, `~/Projects`,
 * `~/code`) and is at least 2 deep on POSIX (drive + 2 on Windows), may absorb other floors. So `/srv/app`,
 * `C:\code\app` and `~/Projects/ovor` qualify.
 */
export const isFoldTarget = (p: FoldCandidate): boolean => {
  if (p.rootSource !== 'git' || p.archived) return false;
  const n = normPath(p.cwd);
  if (HOME_OR_CHILD.some((re) => re.test(n))) return false;
  return segmentCount(n) >= 2;
};

/** The nearest fold target strictly containing `cwd`. */
export function nearestFoldTarget<T extends FoldCandidate>(cwd: string, candidates: readonly T[]): T | undefined {
  return nearestAncestor(cwd, candidates.filter(isFoldTarget));
}
