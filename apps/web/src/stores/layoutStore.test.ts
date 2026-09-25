import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, DEFAULT_LAYOUT_ID, type OfficeLayout } from '@tagconn/shared';
import { layoutForProject, useLayoutStore } from './layoutStore';

const layout = (id: string, over: Partial<OfficeLayout> = {}): OfficeLayout => ({
  ...DEFAULT_LAYOUT,
  id,
  name: id,
  builtin: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe('layoutStore', () => {
  beforeEach(() => {
    useLayoutStore.setState({ layouts: {} });
  });

  it('setLayouts replaces the whole map, indexed by id', () => {
    useLayoutStore.getState().setLayouts([layout('a'), layout('b')]);
    expect(Object.keys(useLayoutStore.getState().layouts).sort()).toEqual(['a', 'b']);
    useLayoutStore.getState().setLayouts([layout('c')]);
    expect(Object.keys(useLayoutStore.getState().layouts)).toEqual(['c']);
  });

  it('upsertLayout inserts and replaces by id', () => {
    useLayoutStore.getState().upsertLayout(layout('a', { name: 'first' }));
    expect(useLayoutStore.getState().layouts.a?.name).toBe('first');
    useLayoutStore.getState().upsertLayout(layout('a', { name: 'second' }));
    expect(useLayoutStore.getState().layouts.a?.name).toBe('second');
    expect(Object.keys(useLayoutStore.getState().layouts)).toEqual(['a']);
  });

  it('removeLayout removes and is a no-op for unknown ids', () => {
    useLayoutStore.getState().setLayouts([layout('a'), layout('b')]);
    useLayoutStore.getState().removeLayout('a');
    expect(Object.keys(useLayoutStore.getState().layouts)).toEqual(['b']);
    useLayoutStore.getState().removeLayout('nope'); // no-op
    expect(Object.keys(useLayoutStore.getState().layouts)).toEqual(['b']);
  });

  describe('layoutForProject', () => {
    it("prefers the project's own layoutId when it resolves", () => {
      const layouts = { mine: layout('mine'), fallback: layout('fallback') };
      expect(layoutForProject(layouts, { layoutId: 'mine' }, 'fallback').id).toBe('mine');
    });

    it('falls back to the settings default when the layoutId is unset or unknown', () => {
      const layouts = { fallback: layout('fallback') };
      expect(layoutForProject(layouts, { layoutId: undefined }, 'fallback').id).toBe('fallback');
      expect(layoutForProject(layouts, { layoutId: 'missing' }, 'fallback').id).toBe('fallback');
    });

    it("falls back to the builtin 'default' layout when the settings default is also missing", () => {
      const layouts = { [DEFAULT_LAYOUT_ID]: layout(DEFAULT_LAYOUT_ID, { name: 'Seeded default' }) };
      expect(layoutForProject(layouts, { layoutId: 'missing' }, 'also-missing').name).toBe('Seeded default');
    });

    it('falls back to the shared DEFAULT_LAYOUT constant when nothing is loaded yet', () => {
      expect(layoutForProject({}, undefined, 'missing')).toBe(DEFAULT_LAYOUT);
      expect(layoutForProject({}, { layoutId: 'missing' }, 'missing').id).toBe(DEFAULT_LAYOUT.id);
    });
  });
});
