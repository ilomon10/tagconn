import { describe, expect, it } from 'vitest';
import type { Project } from '@tagconn/shared';
import { isProjectDirAllowed, projectScopeOptions } from './scope';

const project = (id: string, cwd: string): Project => ({ id, cwd, name: id, archived: false, createdAt: 1, lastActivityAt: 1 });

describe('isProjectDirAllowed', () => {
  it('allows a cwd exactly equal to an allowed dir', () => {
    expect(isProjectDirAllowed('/home/user/proj', ['/home/user/proj'])).toBe(true);
  });

  it('allows a cwd nested under an allowed dir', () => {
    expect(isProjectDirAllowed('/home/user/proj/sub', ['/home/user/proj'])).toBe(true);
  });

  it('rejects a cwd outside every allowed dir', () => {
    expect(isProjectDirAllowed('/home/user/other', ['/home/user/proj'])).toBe(false);
  });

  it('rejects a sibling dir that merely shares a prefix (no path-boundary confusion)', () => {
    expect(isProjectDirAllowed('/home/user/projects-evil', ['/home/user/proj'])).toBe(false);
  });

  it('ignores a trailing slash on either side', () => {
    expect(isProjectDirAllowed('/home/user/proj/', ['/home/user/proj/'])).toBe(true);
  });

  it('"/" allows everything below it', () => {
    expect(isProjectDirAllowed('/anything/at/all', ['/'])).toBe(true);
  });

  it('returns false with no allowed dirs configured', () => {
    expect(isProjectDirAllowed('/home/user/proj', [])).toBe(false);
  });
});

describe('projectScopeOptions', () => {
  it('marks each project allowed/disallowed independently, preserving order', () => {
    const projects = [project('p1', '/home/user/allowed'), project('p2', '/home/user/blocked')];
    const options = projectScopeOptions(projects, ['/home/user/allowed']);
    expect(options.map((o) => [o.project.id, o.allowed])).toEqual([
      ['p1', true],
      ['p2', false],
    ]);
  });

  it('is empty for an empty project list', () => {
    expect(projectScopeOptions([], ['/home/user'])).toEqual([]);
  });
});
