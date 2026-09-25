import { beforeEach, describe, expect, it } from 'vitest';
import type { LayoutRoom, OfficeLayout } from '@tagconn/shared';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { genRoomId, useEditorStore } from './editorStore';

const room = (over: Partial<LayoutRoom> = {}): LayoutRoom => ({ id: 'a', type: 'desks', x: 0, y: 0, w: 6, h: 5, ...over });

const layout = (over: Partial<OfficeLayout> = {}): OfficeLayout => ({
  ...DEFAULT_LAYOUT,
  id: 'mine',
  name: 'Mine',
  builtin: false,
  createdAt: 1,
  updatedAt: 1,
  rooms: [room()],
  ...over,
});

const closeStore = () => useEditorStore.getState().close();

describe('editorStore', () => {
  beforeEach(closeStore);

  it('load() seeds the draft, clears history, and marks it clean', () => {
    useEditorStore.getState().load(layout());
    const s = useEditorStore.getState();
    expect(s.draft?.rooms).toHaveLength(1);
    expect(s.originalId).toBe('mine');
    expect(s.builtin).toBe(false);
    expect(s.dirty).toBe(false);
    expect(s.history).toEqual([]);
  });

  it('createNew() starts a blank, dirty, unsaved draft', () => {
    useEditorStore.getState().createNew({ name: 'Blank' });
    const s = useEditorStore.getState();
    expect(s.draft?.name).toBe('Blank');
    expect(s.draft?.rooms).toEqual([]);
    expect(s.originalId).toBeUndefined();
    expect(s.dirty).toBe(true);
  });

  describe('draw (addRoom)', () => {
    it('appends a room as one commit and marks the draft dirty', () => {
      useEditorStore.getState().load(layout({ rooms: [] }));
      useEditorStore.getState().addRoom(room({ id: 'new' }));
      const s = useEditorStore.getState();
      expect(s.draft?.rooms.map((r) => r.id)).toEqual(['new']);
      expect(s.history).toHaveLength(1);
      expect(s.dirty).toBe(true);
    });

    it('is a no-op while editing a builtin (read-only until duplicated)', () => {
      useEditorStore.getState().load(layout({ builtin: true }));
      useEditorStore.getState().addRoom(room({ id: 'new' }));
      expect(useEditorStore.getState().draft?.rooms).toHaveLength(1); // unchanged
      expect(useEditorStore.getState().history).toEqual([]);
    });

    it('duplicateAsEditable() lifts the builtin guard', () => {
      useEditorStore.getState().load(layout({ builtin: true }));
      useEditorStore.getState().duplicateAsEditable();
      expect(useEditorStore.getState().builtin).toBe(false);
      expect(useEditorStore.getState().originalId).toBeUndefined();
      useEditorStore.getState().addRoom(room({ id: 'new' }));
      expect(useEditorStore.getState().draft?.rooms.map((r) => r.id)).toContain('new');
    });
  });

  describe('move (drag gesture)', () => {
    it('coalesces many moveRoomsBy calls into exactly one undo entry', () => {
      useEditorStore.getState().load(layout({ rooms: [room({ x: 2, y: 2 })] }));
      const before = useEditorStore.getState().history.length;
      useEditorStore.getState().beginGesture();
      useEditorStore.getState().moveRoomsBy(['a'], 1, 0);
      useEditorStore.getState().moveRoomsBy(['a'], 1, 0);
      useEditorStore.getState().moveRoomsBy(['a'], 0, 3);
      useEditorStore.getState().endGesture();
      const s = useEditorStore.getState();
      expect(s.draft?.rooms[0]).toMatchObject({ x: 4, y: 5 });
      expect(s.history).toHaveLength(before + 1);
      useEditorStore.getState().undo();
      expect(useEditorStore.getState().draft?.rooms[0]).toMatchObject({ x: 2, y: 2 });
    });

    it('drops the gesture entry entirely if it ends back where it started', () => {
      useEditorStore.getState().load(layout({ rooms: [room({ x: 2, y: 2 })] }));
      useEditorStore.getState().beginGesture();
      useEditorStore.getState().moveRoomsBy(['a'], 3, 0);
      useEditorStore.getState().moveRoomsBy(['a'], -3, 0);
      useEditorStore.getState().endGesture();
      expect(useEditorStore.getState().history).toEqual([]);
    });

    it('cancelGesture() (Esc) restores the pre-drag draft without touching history', () => {
      useEditorStore.getState().load(layout({ rooms: [room({ x: 2, y: 2 })] }));
      useEditorStore.getState().beginGesture();
      useEditorStore.getState().moveRoomsBy(['a'], 5, 5);
      useEditorStore.getState().cancelGesture();
      const s = useEditorStore.getState();
      expect(s.draft?.rooms[0]).toMatchObject({ x: 2, y: 2 });
      expect(s.history).toEqual([]);
      expect(s.gestureBaseline).toBeNull();
    });
  });

  describe('resize', () => {
    it('coalesces a resize gesture into one undo entry', () => {
      useEditorStore.getState().load(layout({ rooms: [room({ w: 6, h: 5 })] }));
      useEditorStore.getState().beginGesture();
      useEditorStore.getState().resizeRoomTo('a', { w: 7 });
      useEditorStore.getState().resizeRoomTo('a', { w: 8, h: 6 });
      useEditorStore.getState().endGesture();
      const s = useEditorStore.getState();
      expect(s.draft?.rooms[0]).toMatchObject({ w: 8, h: 6 });
      expect(s.history).toHaveLength(1);
      useEditorStore.getState().undo();
      expect(useEditorStore.getState().draft?.rooms[0]).toMatchObject({ w: 6, h: 5 });
    });
  });

  describe('delete', () => {
    it('removeRooms deletes and drops the id from the selection, in one commit', () => {
      useEditorStore.getState().load(layout({ rooms: [room({ id: 'a' }), room({ id: 'b', x: 20 })] }));
      useEditorStore.getState().select(['a', 'b']);
      useEditorStore.getState().removeRooms(['a']);
      const s = useEditorStore.getState();
      expect(s.draft?.rooms.map((r) => r.id)).toEqual(['b']);
      expect(s.selection).toEqual(['b']);
      expect(s.history).toHaveLength(1);
    });
  });

  describe('duplicateRooms', () => {
    it('clones the selected rooms with fresh ids, offset by one tile, and selects the clones', () => {
      useEditorStore.getState().load(layout({ rooms: [room({ id: 'a', x: 2, y: 2 })] }));
      useEditorStore.getState().duplicateRooms(['a']);
      const s = useEditorStore.getState();
      expect(s.draft?.rooms).toHaveLength(2);
      const clone = s.draft?.rooms.find((r) => r.id !== 'a');
      expect(clone).toMatchObject({ x: 3, y: 3 });
      expect(s.selection).toEqual([clone!.id]);
    });
  });

  describe('undo / redo', () => {
    it('undo is a no-op with empty history; redo is a no-op with empty future', () => {
      useEditorStore.getState().load(layout());
      useEditorStore.getState().undo();
      expect(useEditorStore.getState().history).toEqual([]);
      useEditorStore.getState().redo();
      expect(useEditorStore.getState().future).toEqual([]);
    });

    it('redo restores what undo took back, and a new commit clears the redo stack', () => {
      useEditorStore.getState().load(layout({ rooms: [] }));
      useEditorStore.getState().addRoom(room({ id: 'a' }));
      useEditorStore.getState().addRoom(room({ id: 'b', x: 10 }));
      useEditorStore.getState().undo();
      expect(useEditorStore.getState().draft?.rooms.map((r) => r.id)).toEqual(['a']);
      useEditorStore.getState().redo();
      expect(useEditorStore.getState().draft?.rooms.map((r) => r.id)).toEqual(['a', 'b']);
      useEditorStore.getState().undo();
      useEditorStore.getState().addRoom(room({ id: 'c', x: 20 }));
      expect(useEditorStore.getState().future).toEqual([]);
      useEditorStore.getState().redo(); // no-op: redo stack was cleared by the new commit
      expect(useEditorStore.getState().draft?.rooms.map((r) => r.id)).toEqual(['a', 'c']);
    });

    it('caps history at 100 entries', () => {
      useEditorStore.getState().load(layout({ rooms: [] }));
      for (let i = 0; i < 105; i++) useEditorStore.getState().addRoom(room({ id: `r${i}`, x: i }));
      expect(useEditorStore.getState().history.length).toBe(100);
    });
  });

  describe('nudgeSelection', () => {
    it('moves every selected room by one commit per call', () => {
      useEditorStore.getState().load(layout({ rooms: [room({ id: 'a', x: 2, y: 2 })] }));
      useEditorStore.getState().select(['a']);
      useEditorStore.getState().nudgeSelection(1, 0);
      useEditorStore.getState().nudgeSelection(0, 5); // shift+arrow
      const s = useEditorStore.getState();
      expect(s.draft?.rooms[0]).toMatchObject({ x: 3, y: 7 });
      expect(s.history).toHaveLength(2);
    });

    it('is a no-op with nothing selected', () => {
      useEditorStore.getState().load(layout({ rooms: [room({ x: 2, y: 2 })] }));
      useEditorStore.getState().nudgeSelection(1, 0);
      expect(useEditorStore.getState().draft?.rooms[0]).toMatchObject({ x: 2, y: 2 });
      expect(useEditorStore.getState().history).toEqual([]);
    });
  });

  describe('selection', () => {
    it('select replaces by default and adds when additive', () => {
      useEditorStore.getState().load(layout());
      useEditorStore.getState().select(['a']);
      expect(useEditorStore.getState().selection).toEqual(['a']);
      useEditorStore.getState().select(['b'], true);
      expect(useEditorStore.getState().selection.sort()).toEqual(['a', 'b']);
      useEditorStore.getState().select(['c']);
      expect(useEditorStore.getState().selection).toEqual(['c']);
      useEditorStore.getState().clearSelection();
      expect(useEditorStore.getState().selection).toEqual([]);
    });
  });

  it('genRoomId returns ids matching the shared ROOM_ID_RE pattern', () => {
    for (let i = 0; i < 20; i++) expect(genRoomId()).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });
});
