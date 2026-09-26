import type { Project } from '@tagconn/shared';

/**
 * Client-side mirror of the server's project-scope gate (§4.1: "This project: allowed only for a
 * registered project inside `allowedProjectDirs`"; server logic in
 * `apps/server/src/modules/receptionist/receptionist.validate.ts#isProjectDirAllowed`). This is UX
 * only — disabling an option and explaining why — never the source of truth: the server re-checks
 * with the same normalized-prefix logic at create/send time, and the runner re-checks again with a
 * real `realpath()` (docs/design/runner-and-helpdesk.md §2.3/§9). A Linux/macOS-only tool, so `/` is
 * the only separator considered (no `node:path`, which isn't available in the browser).
 */

function normalizeDir(raw: string): string {
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

export function isProjectDirAllowed(cwd: string, allowedDirs: readonly string[]): boolean {
  const target = normalizeDir(cwd);
  return allowedDirs.some((raw) => {
    const dir = normalizeDir(raw);
    if (dir === '/') return true; // an operator who allowlists "/" allows everything below it
    return target === dir || target.startsWith(`${dir}/`);
  });
}

export interface ScopeableProject {
  project: Project;
  allowed: boolean;
}

/** Every registered, non-Multiverse floor, each marked with whether the Receptionist may use it as
 *  "This project" scope right now (§4.1: "others disabled with explanation"). */
export function projectScopeOptions(projects: readonly Project[], allowedProjectDirs: readonly string[]): ScopeableProject[] {
  return projects.map((project) => ({ project, allowed: isProjectDirAllowed(project.cwd, allowedProjectDirs) }));
}

export const PROJECT_SCOPE_DISABLED_REASON = 'Outside the runner’s allowed project directories (settings → Runner).';
