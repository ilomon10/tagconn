// Receptionist general-scope docs copy (docs/design/runner-and-helpdesk.md §4.2 "Docs copy").
// Copies README.md, CLAUDE.md, ROADMAP.md and docs/** from the runner's own repo checkout into
// `<stateDir>/receptionist-docs` (0700), for the general-scope `--add-dir`. Never the repo root, and
// symlinks are never followed (V4: a symlink's permissions follow its TARGET).

import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECEPTIONIST_DOCS_COPY } from '@tagconn/shared';

/** Searches upward from `startDir` for the repo's workspace root (pnpm-workspace.yaml + CLAUDE.md). */
export function findRepoRoot(startDir: string, maxLevels = 8): string | undefined {
  let dir = startDir;
  for (let i = 0; i < maxLevels; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'CLAUDE.md'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** This module's own directory works for both `src/` (tsx dev) and `dist/` (tsup build): both sit
 *  three levels under the repo root (`<root>/apps/runner/{src,dist}`). */
export function defaultRepoRoot(): string | undefined {
  return findRepoRoot(dirname(fileURLToPath(import.meta.url)));
}

function copyNoSymlinks(src: string, dest: string): void {
  cpSync(src, dest, {
    recursive: true,
    dereference: false,
    filter: (from) => !lstatSync(from).isSymbolicLink(),
  });
}

export interface DocsCopyResult {
  destDir: string;
  copied: string[];
  skipped: string[];
}

/**
 * Refreshes `<stateDir>/receptionist-docs` from `repoRoot`. Idempotent: the dest dir is recreated each
 * time so stale files never linger. Returns which of RECEPTIONIST_DOCS_COPY existed and were copied.
 */
export function refreshReceptionistDocs(repoRoot: string, stateDir: string): DocsCopyResult {
  const destDir = join(stateDir, 'receptionist-docs');
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true, mode: 0o700 });

  const copied: string[] = [];
  const skipped: string[] = [];
  for (const entry of RECEPTIONIST_DOCS_COPY) {
    const src = join(repoRoot, entry);
    if (!existsSync(src) || lstatSync(src).isSymbolicLink()) {
      skipped.push(entry);
      continue;
    }
    copyNoSymlinks(src, join(destDir, entry));
    copied.push(entry);
  }
  return { destDir, copied, skipped };
}
