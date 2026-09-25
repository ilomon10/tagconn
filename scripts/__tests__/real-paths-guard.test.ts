// Belt-and-suspenders companion to scripts/__tests__/support/global-guard.ts
// (the vitest globalSetup teardown): records a baseline of the REAL
// ~/.config/tagconn and ~/.claude/settings.json here too, and fails via a
// plain afterAll if anything in this run touched them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffRealPaths, type RealPathsSnapshot, snapshotRealPaths } from './support/real-paths-guard.ts';

let before: RealPathsSnapshot;

beforeAll(() => {
  before = snapshotRealPaths();
});

afterAll(() => {
  const diffs = diffRealPaths(before);
  expect(diffs, diffs.join('\n\n')).toEqual([]);
});

describe('real ~/.config/tagconn and ~/.claude/settings.json guard', () => {
  it('records a baseline snapshot for afterAll to compare against', () => {
    expect(before.configDir).toBeTruthy();
    expect(before.settings).toBeTruthy();
  });
});
