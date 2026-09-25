import { beforeEach, describe, expect, it } from 'vitest';
import { AckError } from './socket';
import { classifySaveLayoutError, saveLayout } from './layoutCommands';
import { useOfficeStore } from '../stores/officeStore';
import { useLayoutStore } from '../stores/layoutStore';
import { DEFAULT_LAYOUT } from '@tagconn/shared';

/**
 * `classifySaveLayoutError` matches the server's message text — both the REST 409 body's `error`
 * and the `layouts:save` socket ack only carry a message, no status code (see layoutCommands.ts's
 * doc comment) — so these fixtures are the exact strings `layouts.service.ts` throws.
 */
describe('classifySaveLayoutError', () => {
  it('recognizes the office.maxStoredLayouts cap message', () => {
    const err = new AckError('Cannot create layout: at most 200 layouts may be stored (office.maxStoredLayouts)');
    expect(classifySaveLayoutError(err)).toEqual({ kind: 'max-stored', message: err.message });
  });

  it('recognizes a stale baseUpdatedAt (someone else saved first)', () => {
    const err = new Error('Layout "a" was changed since you loaded it');
    expect(classifySaveLayoutError(err)).toEqual({ kind: 'conflict', message: err.message });
  });

  it('recognizes a deleted-elsewhere conflict', () => {
    const err = new Error('Layout "a" no longer exists (it was likely deleted by someone else)');
    expect(classifySaveLayoutError(err)).toEqual({ kind: 'conflict', message: err.message });
  });

  it('falls back to "other" for anything else (e.g. a validation or network error)', () => {
    const err = new Error('Not connected to the office server');
    expect(classifySaveLayoutError(err)).toEqual({ kind: 'other', message: err.message });
  });

  it('stringifies a non-Error throw', () => {
    expect(classifySaveLayoutError('boom')).toEqual({ kind: 'other', message: 'boom' });
  });
});

describe('saveLayout (demo mode)', () => {
  beforeEach(() => {
    useOfficeStore.setState({ connection: 'demo' });
    useLayoutStore.setState({ layouts: {} });
  });

  it('ignores baseUpdatedAt (a single demo client never conflicts with itself)', async () => {
    const first = await saveLayout({ ...DEFAULT_LAYOUT, id: undefined, name: 'Demo Floor' });
    const second = await saveLayout({ ...first, name: 'Renamed', baseUpdatedAt: first.updatedAt - 1000 });
    expect(second.name).toBe('Renamed');
    expect((second as Record<string, unknown>).baseUpdatedAt).toBeUndefined();
  });
});
