import { describe, expect, it } from 'vitest';
import type { AttributionWriteResult, PendingProfileImport } from '@tagconn/shared';
import { describeImport, describeSaveResult, describeSaveTarget, removePending, upsertPending } from './reducer';

const item = (patch: Partial<PendingProfileImport> = {}): PendingProfileImport => ({
  projectId: 'p1',
  projectCwd: '/repos/widget',
  receivedAt: Date.now(),
  floorName: 'Widget HQ',
  tagconnVersion: '0.3.0',
  hasLayout: true,
  heroCount: 2,
  unknownRoles: [],
  ...patch,
});

describe('upsertPending', () => {
  it('prepends a new project (newest-first)', () => {
    const a = item({ projectId: 'a' });
    const b = item({ projectId: 'b' });
    expect(upsertPending([a], b)).toEqual([b, a]);
  });

  it('replaces (never duplicates) a re-push for the same project', () => {
    const a = item({ projectId: 'a', heroCount: 1 });
    const updated = item({ projectId: 'a', heroCount: 5 });
    const next = upsertPending([a], updated);
    expect(next).toEqual([updated]);
    expect(next).toHaveLength(1);
  });

  it('keeps other entries untouched, replacing in place rather than moving to the front', () => {
    const a = item({ projectId: 'a' });
    const b = item({ projectId: 'b' });
    const updatedA = item({ projectId: 'a', heroCount: 9 });
    expect(upsertPending([b, a], updatedA)).toEqual([b, updatedA]);
  });
});

describe('removePending', () => {
  it('drops the matching project only', () => {
    const a = item({ projectId: 'a' });
    const b = item({ projectId: 'b' });
    expect(removePending([a, b], 'a')).toEqual([b]);
  });

  it('is a no-op when the project is not pending', () => {
    const a = item({ projectId: 'a' });
    expect(removePending([a], 'missing')).toEqual([a]);
  });
});

describe('describeImport', () => {
  it('lists the floor, layout and hero count', () => {
    const { items, skipped } = describeImport(item({ floorName: 'Widget HQ', hasLayout: true, heroCount: 2 }));
    expect(items).toEqual(['Floor "Widget HQ"', 'a saved layout', '2 heroes']);
    expect(skipped).toBeNull();
  });

  it('singularizes one hero and omits layout/heroes when absent', () => {
    const { items } = describeImport(item({ hasLayout: false, heroCount: 1 }));
    expect(items).toEqual(['Floor "Widget HQ"', '1 hero']);
  });

  it('omits heroes entirely when there are none', () => {
    const { items } = describeImport(item({ hasLayout: false, heroCount: 0 }));
    expect(items).toEqual(['Floor "Widget HQ"']);
  });

  it('reports skipped unknown roles by name and count', () => {
    const { skipped } = describeImport(item({ unknownRoles: ['ranger'] }));
    expect(skipped).toBe('1 hero skipped (role not found here): ranger');
  });

  it('pluralizes multiple skipped roles', () => {
    const { skipped } = describeImport(item({ unknownRoles: ['ranger', 'bard'] }));
    expect(skipped).toBe('2 heroes skipped (role not found here): ranger, bard');
  });
});

describe('describeSaveTarget', () => {
  it('lists the floor, layout and hero count', () => {
    expect(describeSaveTarget('Widget HQ', true, 2)).toEqual(['Floor "Widget HQ"', 'the current layout', '2 heroes']);
  });

  it('singularizes one hero and omits the layout when absent', () => {
    expect(describeSaveTarget('Widget HQ', false, 1)).toEqual(['Floor "Widget HQ"', '1 hero']);
  });

  it('omits heroes entirely when there are none', () => {
    expect(describeSaveTarget('Widget HQ', false, 0)).toEqual(['Floor "Widget HQ"']);
  });
});

describe('describeSaveResult', () => {
  const result = (patch: Partial<AttributionWriteResult> = {}): AttributionWriteResult => ({
    written: true,
    existed: false,
    relativePath: '.tagconn/office.json',
    ...patch,
  });

  it('a fresh write needs no overwrite confirm', () => {
    expect(describeSaveResult(result({ written: true, existed: false }))).toEqual({
      message: 'Saved to .tagconn/office.json.',
      needsOverwriteConfirm: false,
    });
  });

  it('an overwritten file says so, and still needs no further confirm', () => {
    expect(describeSaveResult(result({ written: true, existed: true }))).toEqual({
      message: 'Saved to .tagconn/office.json (overwritten).',
      needsOverwriteConfirm: false,
    });
  });

  it('an existing file that was NOT written asks the caller to confirm an overwrite', () => {
    expect(describeSaveResult(result({ written: false, existed: true }))).toEqual({
      message: '.tagconn/office.json already exists in this project.',
      needsOverwriteConfirm: true,
    });
  });
});
