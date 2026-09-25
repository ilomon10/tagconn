import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findRepoRoot, refreshReceptionistDocs } from '../../src/docsCopy.js';
import { mkSandbox, rmSandbox } from '../helpers.js';

function makeFakeRepo(root: string) {
  writeFileSync(join(root, 'README.md'), '# readme');
  writeFileSync(join(root, 'CLAUDE.md'), '# claude');
  writeFileSync(join(root, 'ROADMAP.md'), '# roadmap');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'architecture.md'), '# arch');
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []');
}

describe('findRepoRoot', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  it('finds a root containing both pnpm-workspace.yaml and CLAUDE.md', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    makeFakeRepo(root);
    const nested = join(root, 'apps', 'runner', 'src');
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(root);
  });

  it('returns undefined if no ancestor has the markers', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    expect(findRepoRoot(root, 3)).toBeUndefined();
  });
});

describe('refreshReceptionistDocs', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  it('copies README.md, CLAUDE.md, ROADMAP.md and docs/ into <stateDir>/receptionist-docs', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    makeFakeRepo(root);
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);

    const result = refreshReceptionistDocs(root, stateDir);
    expect(result.copied.sort()).toEqual(['CLAUDE.md', 'README.md', 'ROADMAP.md', 'docs'].sort());
    expect(readFileSync(join(result.destDir, 'README.md'), 'utf8')).toBe('# readme');
    expect(readFileSync(join(result.destDir, 'docs', 'architecture.md'), 'utf8')).toBe('# arch');
  });

  it('never copies the repo root itself, only the listed entries', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    makeFakeRepo(root);
    writeFileSync(join(root, 'secret-file-not-in-the-list.txt'), 'nope');
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);

    const result = refreshReceptionistDocs(root, stateDir);
    expect(existsSync(join(result.destDir, 'secret-file-not-in-the-list.txt'))).toBe(false);
  });

  it('never follows a symlinked entry (V4: a symlink target keeps its own permissions)', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    makeFakeRepo(root);
    // Replace CLAUDE.md with a symlink pointing outside the repo (e.g. at a secret).
    const outside = mkSandbox();
    sandboxes.push(outside);
    writeFileSync(join(outside, 'secret.md'), 'TOP SECRET');
    rmSync(join(root, 'CLAUDE.md'));
    symlinkSync(join(outside, 'secret.md'), join(root, 'CLAUDE.md'));
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);

    const result = refreshReceptionistDocs(root, stateDir);
    expect(result.skipped).toContain('CLAUDE.md');
    expect(existsSync(join(result.destDir, 'CLAUDE.md'))).toBe(false);
  });

  it('never follows a symlink nested inside docs/', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    makeFakeRepo(root);
    const outside = mkSandbox();
    sandboxes.push(outside);
    writeFileSync(join(outside, 'leak.md'), 'leak');
    symlinkSync(join(outside, 'leak.md'), join(root, 'docs', 'leak-link.md'));
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);

    const result = refreshReceptionistDocs(root, stateDir);
    expect(existsSync(join(result.destDir, 'docs', 'leak-link.md'))).toBe(false);
  });

  it('the dest dir is created with mode 0700', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    makeFakeRepo(root);
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const result = refreshReceptionistDocs(root, stateDir);
    expect(statSync(result.destDir).mode & 0o777).toBe(0o700);
  });

  it('is idempotent: re-running removes stale files from a previous copy', () => {
    const root = mkSandbox();
    sandboxes.push(root);
    makeFakeRepo(root);
    const stateDir = mkSandbox();
    sandboxes.push(stateDir);
    const first = refreshReceptionistDocs(root, stateDir);
    writeFileSync(join(first.destDir, 'stale.txt'), 'stale');
    refreshReceptionistDocs(root, stateDir);
    expect(existsSync(join(first.destDir, 'stale.txt'))).toBe(false);
  });
});
