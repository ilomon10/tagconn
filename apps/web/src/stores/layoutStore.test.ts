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

  describe('client hardening: unsafe ids never resolve to Object.prototype members', () => {
    it("upsertLayout/removeLayout keep the map's prototype null (no accidental Object.prototype inheritance)", () => {
      useLayoutStore.getState().upsertLayout(layout('a'));
      expect(Object.getPrototypeOf(useLayoutStore.getState().layouts)).toBeNull();
      useLayoutStore.getState().removeLayout('a');
      expect(Object.getPrototypeOf(useLayoutStore.getState().layouts)).toBeNull();
    });

    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('a layout id of %j never resolves via prototype lookup', (id) => {
      // No layout was ever stored under this id: a plain-object map would still "find" one via the
      // inherited Object.prototype member (a function), which is exactly the bug this guards against.
      expect(layoutForProject({}, { layoutId: id }, 'fallback')).toBe(DEFAULT_LAYOUT);
      useLayoutStore.getState().setLayouts([layout('fallback')]);
      expect(layoutForProject(useLayoutStore.getState().layouts, { layoutId: id }, 'fallback').id).toBe('fallback');
    });

    it('setLayouts stores an entry under a reserved-word id as a plain own property, not a prototype change', () => {
      // `LAYOUT_ID_RE` rejects "constructor" for a NEW save, but an old snapshot or a future id
      // scheme could still hand one to the client — the map itself must stay inert either way.
      useLayoutStore.getState().setLayouts([layout('constructor', { name: 'Sneaky' })]);
      const layouts = useLayoutStore.getState().layouts;
      expect(Object.hasOwn(layouts, 'constructor')).toBe(true);
      expect(Object.getPrototypeOf(layouts)).toBeNull();
      // `layoutForProject` then correctly refuses it: the schema it re-validates against rejects
      // "constructor" as an id too, so it falls through to the next candidate instead of using it.
      expect(layoutForProject(layouts, { layoutId: 'constructor' }, 'fallback')).toBe(DEFAULT_LAYOUT);
    });

    it('layoutForProject falls back to DEFAULT_LAYOUT for a malformed stored entry instead of returning it as-is', () => {
      const broken = { ...layout('broken'), rooms: 'not-an-array' } as unknown as OfficeLayout;
      useLayoutStore.setState({ layouts: { broken } });
      expect(layoutForProject(useLayoutStore.getState().layouts, { layoutId: 'broken' }, 'missing')).toBe(DEFAULT_LAYOUT);
    });
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
