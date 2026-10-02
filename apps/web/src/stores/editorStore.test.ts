import { beforeEach, describe, expect, it } from 'vitest';
import { PinnedFurnitureSchema, validateLayout, type LayoutRoom, type OfficeLayout } from '@tagconn/shared';
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

  describe('originalUpdatedAt (save concurrency, M7 hardening)', () => {
    it('load() remembers the saved updatedAt, for the next save to send back as baseUpdatedAt', () => {
      useEditorStore.getState().load(layout({ updatedAt: 42 }));
      expect(useEditorStore.getState().originalUpdatedAt).toBe(42);
    });

    it('createNew()/close()/duplicateAsEditable() all clear it (no baseUpdatedAt on a create)', () => {
      useEditorStore.getState().load(layout({ updatedAt: 42 }));
      useEditorStore.getState().duplicateAsEditable();
      expect(useEditorStore.getState().originalUpdatedAt).toBeUndefined();
      useEditorStore.getState().load(layout({ updatedAt: 42 }));
      useEditorStore.getState().createNew();
      expect(useEditorStore.getState().originalUpdatedAt).toBeUndefined();
      useEditorStore.getState().load(layout({ updatedAt: 42 }));
      useEditorStore.getState().close();
      expect(useEditorStore.getState().originalUpdatedAt).toBeUndefined();
    });

    it('applySaved() adopts the server-returned updatedAt for the next save', () => {
      useEditorStore.getState().load(layout({ updatedAt: 1 }));
      useEditorStore.getState().applySaved(layout({ updatedAt: 2 }));
      expect(useEditorStore.getState().originalUpdatedAt).toBe(2);
    });
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

  // ------------------------------------------------------------------------------------ M8 8n
  const walledRoom = (over: Partial<LayoutRoom> = {}): LayoutRoom => room({ type: 'meeting-room', w: 8, h: 6, ...over });

  describe('furnishing (M8 8n)', () => {
    it('setRoomFurnish merges into the room furnish, in one commit', () => {
      useEditorStore.getState().load(layout({ rooms: [room()] }));
      useEditorStore.getState().setRoomFurnish('a', { density: 'dense', seats: 6 });
      let s = useEditorStore.getState();
      expect(s.draft?.rooms[0]?.furnish).toEqual({ density: 'dense', seats: 6 });
      expect(s.history).toHaveLength(1);

      useEditorStore.getState().setRoomFurnish('a', { decor: 0.5 });
      s = useEditorStore.getState();
      expect(s.draft?.rooms[0]?.furnish).toEqual({ density: 'dense', seats: 6, decor: 0.5 });
    });

    it('a key patched to undefined falls back (is dropped), and an empty result clears furnish entirely', () => {
      useEditorStore.getState().load(layout({ rooms: [room({ furnish: { density: 'dense' } })] }));
      useEditorStore.getState().setRoomFurnish('a', { density: undefined });
      expect(useEditorStore.getState().draft?.rooms[0]?.furnish).toBeUndefined();
    });

    it('resetRoomFurnish clears every override for that room', () => {
      useEditorStore.getState().load(layout({ rooms: [room({ furnish: { density: 'dense', seats: 4, decor: 0.7 } })] }));
      useEditorStore.getState().resetRoomFurnish('a');
      expect(useEditorStore.getState().draft?.rooms[0]?.furnish).toBeUndefined();
    });

    it('rerollRoomSeed sets a fresh seed but keeps every other furnish field', () => {
      useEditorStore.getState().load(layout({ rooms: [room({ furnish: { density: 'dense', seed: 1 } })] }));
      useEditorStore.getState().rerollRoomSeed('a');
      const f = useEditorStore.getState().draft?.rooms[0]?.furnish;
      expect(f?.density).toBe('dense');
      expect(f?.seed).toBeTypeOf('number');
      expect(f?.seed).not.toBe(1);
    });

    it('setFurnishDefaults merges the layout-wide defaults, dropping keys patched to undefined', () => {
      useEditorStore.getState().load(layout({ furnishDefaults: { density: 'sparse' } }));
      useEditorStore.getState().setFurnishDefaults({ decor: 0.6 });
      expect(useEditorStore.getState().draft?.furnishDefaults).toEqual({ density: 'sparse', decor: 0.6 });
      useEditorStore.getState().setFurnishDefaults({ density: undefined });
      expect(useEditorStore.getState().draft?.furnishDefaults).toEqual({ decor: 0.6 });
    });

    it('furnish edits are no-ops while editing a read-only builtin', () => {
      useEditorStore.getState().load(layout({ builtin: true, rooms: [room()] }));
      useEditorStore.getState().setRoomFurnish('a', { seats: 9 });
      useEditorStore.getState().setFurnishDefaults({ decor: 0.9 });
      expect(useEditorStore.getState().draft?.rooms[0]?.furnish).toBeUndefined();
      expect(useEditorStore.getState().draft?.furnishDefaults).toBeUndefined();
    });
  });

  describe('doors (M8 8n)', () => {
    const auto = [{ side: 'n', offset: 2, width: 1 } as const];

    it('setRoomDoors replaces the door list wholesale; undefined restores automatic doors', () => {
      useEditorStore.getState().load(layout({ rooms: [walledRoom()] }));
      useEditorStore.getState().setRoomDoors('a', [{ side: 's', offset: 1, width: 2 }]);
      expect(useEditorStore.getState().draft?.rooms[0]?.doors).toEqual([{ side: 's', offset: 1, width: 2 }]);
      useEditorStore.getState().setRoomDoors('a', undefined);
      expect(useEditorStore.getState().draft?.rooms[0]?.doors).toBeUndefined();
    });

    it('sealRoom sets doors to [] ("Seal room")', () => {
      useEditorStore.getState().load(layout({ rooms: [walledRoom()] }));
      useEditorStore.getState().sealRoom('a');
      expect(useEditorStore.getState().draft?.rooms[0]?.doors).toEqual([]);
    });

    describe('ensureExplicitDoors (materialize)', () => {
      it('freezes the given auto doors into an explicit list, in one commit', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom()] }));
        useEditorStore.getState().ensureExplicitDoors('a', auto);
        const s = useEditorStore.getState();
        expect(s.draft?.rooms[0]?.doors).toEqual(auto);
        expect(s.history).toHaveLength(1);
      });

      it('is a no-op once the room already has an explicit list, including a sealed []', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom({ doors: [] })] }));
        useEditorStore.getState().ensureExplicitDoors('a', auto);
        const s = useEditorStore.getState();
        expect(s.draft?.rooms[0]?.doors).toEqual([]);
        expect(s.history).toEqual([]);
      });
    });

    describe('addDoor', () => {
      it('materializes the auto list and appends, in one commit, for a still-automatic room', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom()] }));
        useEditorStore.getState().addDoor('a', { side: 'e', offset: 1, width: 1 }, auto);
        const s = useEditorStore.getState();
        expect(s.draft?.rooms[0]?.doors).toEqual([...auto, { side: 'e', offset: 1, width: 1 }]);
        expect(s.history).toHaveLength(1);
      });

      it('appends to an already-explicit list without needing autoDoors', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom({ doors: [{ side: 'n', offset: 1, width: 1 }] })] }));
        useEditorStore.getState().addDoor('a', { side: 's', offset: 1, width: 1 });
        expect(useEditorStore.getState().draft?.rooms[0]?.doors).toEqual([
          { side: 'n', offset: 1, width: 1 },
          { side: 's', offset: 1, width: 1 },
        ]);
      });

      it('refuses past maxDoorsPerRoom', () => {
        const many = Array.from({ length: 8 }, (_, i) => ({ side: 'n' as const, offset: i + 1, width: 1 }));
        useEditorStore.getState().load(layout({ rooms: [walledRoom({ doors: many })] }));
        useEditorStore.getState().addDoor('a', { side: 's', offset: 1, width: 1 });
        expect(useEditorStore.getState().draft?.rooms[0]?.doors).toHaveLength(8);
      });

      it('applies a one-click "Fix" suggestion the same way as any manually-added door', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom()] }));
        const suggestion = { side: 'w' as const, offset: 2, width: 1 };
        useEditorStore.getState().addDoor('a', suggestion, auto);
        expect(useEditorStore.getState().draft?.rooms[0]?.doors).toContainEqual(suggestion);
      });
    });

    describe('updateDoor (move/resize as a single commit)', () => {
      it('materializes then patches the given door', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom()] }));
        useEditorStore.getState().updateDoor('a', 0, { offset: 3 }, auto);
        expect(useEditorStore.getState().draft?.rooms[0]?.doors).toEqual([{ side: 'n', offset: 3, width: 1 }]);
      });

      it('is a no-op for an out-of-range index', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom({ doors: auto.slice() })] }));
        useEditorStore.getState().updateDoor('a', 5, { offset: 3 });
        expect(useEditorStore.getState().draft?.rooms[0]?.doors).toEqual(auto);
      });
    });

    describe('removeDoor', () => {
      it('materializes then removes the given door, and clears a matching selection', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom()] }));
        useEditorStore.getState().selectDoor('a', 0);
        useEditorStore.getState().removeDoor('a', 0, auto);
        const s = useEditorStore.getState();
        expect(s.draft?.rooms[0]?.doors).toEqual([]);
        expect(s.selectedDoor).toBeNull();
      });
    });

    describe('nudgeDoor (keyboard, one commit per call)', () => {
      it('moves the door along its wall, clamped between the corners', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom({ doors: [{ side: 'n', offset: 3, width: 1 }] })] }));
        useEditorStore.getState().nudgeDoor('a', 0, 1);
        expect(useEditorStore.getState().draft?.rooms[0]?.doors?.[0]?.offset).toBe(4);
        useEditorStore.getState().nudgeDoor('a', 0, 100); // clamps instead of running off the wall
        expect(useEditorStore.getState().draft?.rooms[0]?.doors?.[0]?.offset).toBe(6); // len(8) - 1 - width(1)
      });

      it('is a no-op while the room is still automatic (nothing to nudge yet)', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom()] }));
        useEditorStore.getState().nudgeDoor('a', 0, 1);
        expect(useEditorStore.getState().draft?.rooms[0]?.doors).toBeUndefined();
      });
    });

    describe('setDoorRect (drag gesture) + undo/redo coalescing', () => {
      it('coalesces many setDoorRect calls into exactly one undo entry', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom({ doors: [{ side: 'n', offset: 2, width: 1 }] })] }));
        const before = useEditorStore.getState().history.length;
        useEditorStore.getState().beginGesture();
        useEditorStore.getState().setDoorRect('a', 0, { offset: 3 });
        useEditorStore.getState().setDoorRect('a', 0, { offset: 4 });
        useEditorStore.getState().setDoorRect('a', 0, { width: 2 });
        useEditorStore.getState().endGesture();
        const s = useEditorStore.getState();
        expect(s.draft?.rooms[0]?.doors?.[0]).toEqual({ side: 'n', offset: 4, width: 2 });
        expect(s.history).toHaveLength(before + 1);
        useEditorStore.getState().undo();
        expect(useEditorStore.getState().draft?.rooms[0]?.doors?.[0]).toEqual({ side: 'n', offset: 2, width: 1 });
      });
    });

    describe('auto-doors toggle', () => {
      it('"Auto doors" (setRoomDoors(id, undefined)) clears an explicit list back to automatic', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom({ doors: [{ side: 'n', offset: 2, width: 1 }] })] }));
        useEditorStore.getState().setRoomDoors('a', undefined);
        expect(useEditorStore.getState().draft?.rooms[0]?.doors).toBeUndefined();
      });
    });

    describe('door selection', () => {
      it('selectDoor/clearDoorSelection track the current pick', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom()] }));
        useEditorStore.getState().selectDoor('a', 0);
        expect(useEditorStore.getState().selectedDoor).toEqual({ roomId: 'a', index: 0 });
        useEditorStore.getState().clearDoorSelection();
        expect(useEditorStore.getState().selectedDoor).toBeNull();
      });

      it('switching tools away from "doors" clears the door selection', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom()] }));
        useEditorStore.getState().setTool('doors');
        useEditorStore.getState().selectDoor('a', 0);
        useEditorStore.getState().setTool('select');
        expect(useEditorStore.getState().selectedDoor).toBeNull();
      });

      it('selecting a room clears the door selection', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom()] }));
        useEditorStore.getState().selectDoor('a', 0);
        useEditorStore.getState().select(['a']);
        expect(useEditorStore.getState().selectedDoor).toBeNull();
      });

      it('removing the room that owns the selected door clears the selection', () => {
        useEditorStore.getState().load(layout({ rooms: [walledRoom({ id: 'a' }), room({ id: 'b', x: 20 })] }));
        useEditorStore.getState().selectDoor('a', 0);
        useEditorStore.getState().removeRooms(['a']);
        expect(useEditorStore.getState().selectedDoor).toBeNull();
      });
    });
  });
});

describe('editorStore furniture pins (M12)', () => {
  beforeEach(closeStore);
  // Room 'a': 6x5 at 0,0 -> explicitly walled desks, interior 4x3.
  const p = (over: Partial<import('@tagconn/shared').PinnedFurniture> = {}) => ({ kind: 'plant', x: 0, y: 0, w: 1, h: 1, ...over });
  const s = () => useEditorStore.getState();
  const pins = () => s().draft?.rooms[0]?.furniture;
  const load = (r: Partial<LayoutRoom> = {}) => s().load(layout({ rooms: [room({ walled: true, ...r })] }));

  it('lockFurniture adds a pin in one undo step and selects it; identical pins are a no-op', () => {
    load();
    s().lockFurniture('a', p({ x: 1, y: 1 }));
    expect(pins()).toEqual([p({ x: 1, y: 1 })]);
    expect(s().history).toHaveLength(1);
    expect(s().selectedFurniture).toEqual({ roomId: 'a', pinIndex: 0 });
    s().lockFurniture('a', p({ x: 1, y: 1 }));
    expect(pins()).toHaveLength(1);
    expect(s().history).toHaveLength(1);
    s().undo();
    expect(pins()).toBeUndefined();
    expect(s().selectedFurniture).toBeNull();
    s().redo();
    expect(pins()).toHaveLength(1);
  });

  it('refuses a pin outside the interior or overlapping another', () => {
    load({ furniture: [p()] });
    s().lockFurniture('a', p({ x: 4 }));
    s().lockFurniture('a', p({ kind: 'lamp' }));
    expect(pins()).toHaveLength(1);
  });

  it('drag = pinDirect + setPinPos in one gesture / one undo entry', () => {
    load();
    s().beginGesture();
    const i = s().pinDirect('a', p({ x: 1, y: 1 }));
    s().setPinPos('a', i, { x: 2, y: 1 });
    s().setPinPos('a', i, { x: 3, y: 2 });
    s().setPinPos('a', i, { x: 99, y: 99 }); // clamped to the interior (4x3)
    s().endGesture();
    expect(pins()).toEqual([p({ x: 3, y: 2 })]);
    expect(s().history).toHaveLength(1);
    s().undo();
    expect(pins()).toBeUndefined();
  });

  it('setPinPos refuses an overlap: the pin stays at its last valid spot', () => {
    load({ furniture: [p({ x: 0, y: 0 }), p({ kind: 'lamp', x: 3, y: 0 })] });
    s().beginGesture();
    s().setPinPos('a', 1, { x: 2, y: 0 });
    s().setPinPos('a', 1, { x: 0, y: 0 }); // overlaps pin 0
    s().endGesture();
    expect(pins()?.[1]).toMatchObject({ x: 2, y: 0 });
  });

  it('setPinPos refuses an explicit door apron', () => {
    // door n offset 2 -> interior x 1, y 0
    load({ doors: [{ side: 'n', offset: 2 }], furniture: [p({ x: 0, y: 1 })] });
    s().nudgePin('a', 0, 1, -1); // would land on (1,0)
    expect(pins()?.[0]).toMatchObject({ x: 0, y: 1 });
    s().nudgePin('a', 0, 0, 1);
    expect(pins()?.[0]).toMatchObject({ x: 0, y: 2 });
  });

  it('nudgePin clamps to the interior, commits once, and a blocked nudge adds no history', () => {
    load({ furniture: [p({ x: 3, y: 0 })] });
    s().nudgePin('a', 0, 5, 0); // clamped at x=3: no change
    expect(s().history).toHaveLength(0);
    s().nudgePin('a', 0, -5, 2);
    expect(pins()?.[0]).toMatchObject({ x: 0, y: 2 });
    expect(s().history).toHaveLength(1);
    s().undo();
    expect(pins()?.[0]).toMatchObject({ x: 3, y: 0 });
  });

  it('releasePin removes it, clears the selection, and undoes', () => {
    load({ furniture: [p(), p({ kind: 'lamp', x: 2 })] });
    s().selectFurniture({ roomId: 'a', pinIndex: 1 });
    s().releasePin('a', 1);
    expect(pins()).toEqual([p()]);
    expect(s().selectedFurniture).toBeNull();
    s().undo();
    expect(pins()).toHaveLength(2);
    s().releasePin('a', 0);
    s().releasePin('a', 0);
    expect(pins()).toBeUndefined(); // empty list collapses back to fully procedural
  });

  it('lockAll appends valid, non-overlapping pins in one commit; releaseAll clears them in one commit', () => {
    load({ furniture: [p()] });
    s().lockAll('a', [p(), p({ kind: 'lamp', x: 2 }), p({ kind: 'bin', x: 2 }), p({ kind: 'bin', x: 9 })]);
    expect(pins()?.map((x) => x.kind)).toEqual(['plant', 'lamp']);
    expect(s().history).toHaveLength(1);
    s().releaseAll('a');
    expect(pins()).toBeUndefined();
    expect(s().history).toHaveLength(2);
    s().undo();
    expect(pins()).toHaveLength(2);
    s().undo();
    expect(pins()).toHaveLength(1);
  });

  it('lockAll respects the per-room cap', () => {
    load({ w: 20, h: 20 });
    const many = Array.from({ length: 60 }, (_, i) => p({ x: i % 18, y: Math.floor(i / 18) }));
    s().lockAll('a', many);
    expect(pins()).toHaveLength(48);
  });

  it('resizing the room prunes pins that fall outside; a drag restores them when grown back', () => {
    load({ furniture: [p({ x: 3, y: 2 }), p({ kind: 'lamp' })] });
    s().updateRoom('a', { w: 4, h: 4 }); // interior 2x2
    expect(pins()).toEqual([p({ kind: 'lamp' })]);
    s().undo();
    expect(pins()).toHaveLength(2);

    s().beginGesture();
    s().resizeRoomTo('a', { w: 4 });
    expect(pins()).toEqual([p({ kind: 'lamp' })]);
    s().resizeRoomTo('a', { w: 6 });
    s().endGesture();
    expect(pins()).toHaveLength(2);
  });

  it('changing type / walled keeps only pins inside the new interior', () => {
    load({ type: 'lounge', walled: false, furniture: [p({ x: 5, y: 4 })] }); // open room: interior is 6x5
    s().updateRoom('a', { walled: true }); // interior 4x3
    expect(pins()).toBeUndefined();
  });

  it('a draft never fails validateLayout because of pins after any of these edits', () => {
    load({ furniture: [p({ x: 3, y: 2 }), p({ kind: 'lamp', x: 1, y: 1 })] });
    s().updateRoom('a', { w: 5, h: 4 });
    s().updateRoom('a', { doors: [{ side: 'n', offset: 2 }] });
    s().nudgePin('a', 0, -2, -2);
    const issues = validateLayout(s().draft!);
    expect(issues.filter((i) => i.code === 'pinned-invalid')).toEqual([]);
  });

  it('reroll and furnish reset keep pins; moving or duplicating a room carries them', () => {
    load({ furniture: [p({ x: 1, y: 1 })] });
    s().rerollRoomSeed('a');
    s().resetRoomFurnish('a');
    expect(pins()).toEqual([p({ x: 1, y: 1 })]);
    s().select(['a']);
    s().nudgeSelection(2, 1);
    expect(pins()).toEqual([p({ x: 1, y: 1 })]);
    s().duplicateRooms(['a']);
    expect(s().draft?.rooms[1]?.furniture).toEqual([p({ x: 1, y: 1 })]);
  });

  it('a furniture pick follows undo, tool changes and room removal', () => {
    load({ furniture: [p()] });
    s().setTool('furniture');
    s().selectFurniture({ roomId: 'a', pinIndex: 0 });
    expect(s().selection).toEqual(['a']);
    s().setTool('select');
    expect(s().selectedFurniture).toBeNull();
    s().setTool('furniture');
    s().selectFurniture({ roomId: 'a', pinIndex: 0 });
    s().removeRooms(['a']);
    expect(s().selectedFurniture).toBeNull();
  });

  it('is read-only on a builtin', () => {
    s().load(layout({ builtin: true, rooms: [room()] }));
    s().lockFurniture('a', p());
    expect(s().pinDirect('a', p())).toBe(-1);
    expect(pins()).toBeUndefined();
  });
});

describe('editorStore half-tile pins (M15)', () => {
  beforeEach(closeStore);
  // Room 'a': 6x5 walled -> interior 4x3.
  const p = (over: Partial<import('@tagconn/shared').PinnedFurniture> = {}) => ({ kind: 'plant', x: 0, y: 0, w: 1, h: 1, ...over });
  const s = () => useEditorStore.getState();
  const pins = () => s().draft?.rooms[0]?.furniture;
  const load = (r: Partial<LayoutRoom> = {}) => s().load(layout({ rooms: [room({ walled: true, ...r })] }));
  const noPinIssues = () => expect(validateLayout(s().draft!).filter((i) => i.code === 'pinned-invalid')).toEqual([]);

  it('Alt+arrow nudges a pin by 0.5 in one commit each, and undo/redo walk the halves back', () => {
    load({ furniture: [p({ x: 1, y: 1 })] });
    s().nudgePin('a', 0, 0.5, 0);
    expect(pins()?.[0]).toMatchObject({ x: 1.5, y: 1 });
    s().nudgePin('a', 0, 0, -0.5);
    expect(pins()?.[0]).toMatchObject({ x: 1.5, y: 0.5 });
    expect(s().history).toHaveLength(2);
    s().nudgePin('a', 0, 2.5, 0); // Shift+Alt: clamped at x = 3 (interior 4 wide)
    expect(pins()?.[0]).toMatchObject({ x: 3, y: 0.5 });
    s().undo();
    expect(pins()?.[0]).toMatchObject({ x: 1.5, y: 0.5 });
    s().undo();
    expect(pins()?.[0]).toMatchObject({ x: 1.5, y: 1 });
    s().undo();
    expect(pins()?.[0]).toMatchObject({ x: 1, y: 1 });
    s().redo();
    expect(pins()?.[0]).toMatchObject({ x: 1.5, y: 1 });
    noPinIssues();
  });

  it('a half nudge that would overlap another pin or the interior edge is refused without history', () => {
    load({ furniture: [p({ x: 0, y: 0 }), p({ kind: 'lamp', x: 1.5, y: 0 })] });
    s().nudgePin('a', 1, -1, 0); // (0.5,0) overlaps the (0,0) pin by half a tile
    expect(pins()?.[1]).toMatchObject({ x: 1.5, y: 0 });
    s().nudgePin('a', 1, -0.5, 0); // (1,0) is edge-adjacent: fine
    expect(pins()?.[1]).toMatchObject({ x: 1, y: 0 });
    expect(s().history).toHaveLength(1);
    s().nudgePin('a', 1, 2.5, 0); // clamp to x=3 (1 + 2.5 = 3.5 pokes out)
    expect(pins()?.[1]).toMatchObject({ x: 3, y: 0 });
    s().nudgePin('a', 1, 0.5, 0); // already at the clamp: no change, no history
    expect(s().history).toHaveLength(2);
    noPinIssues();
  });

  it('setPinPos snaps a fractional drag position to halves inside one gesture', () => {
    load();
    s().beginGesture();
    const i = s().pinDirect('a', p({ x: 1, y: 1 }));
    s().setPinPos('a', i, { x: 1.3, y: 0.6 });
    expect(pins()?.[0]).toMatchObject({ x: 1.5, y: 0.5 });
    s().setPinPos('a', i, { x: 3.4, y: 2.2 }); // 3.5 would poke out: clamped to 3
    expect(pins()?.[0]).toMatchObject({ x: 3, y: 2 });
    s().endGesture();
    expect(s().history).toHaveLength(1);
    expect(PinnedFurnitureSchema.safeParse(pins()?.[0]).success).toBe(true);
    s().undo();
    expect(pins()).toBeUndefined();
  });

  it('property: no sequence of drags / nudges / undos ever yields pinned-invalid or an unaligned pin', () => {
    // Small xorshift PRNG so the run is reproducible.
    const prng = (seed: number) => () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return ((seed >>> 0) % 10_000) / 10_000;
    };
    const steps = [-5, -2.5, -1, -0.5, 0.5, 1, 2.5, 5];
    for (const seed of [11, 23, 97]) {
      const rnd = prng(seed);
      const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
      // 8x6 walled room -> interior 6x4, one N door (apron tile (2,0)), three pins of mixed sizes.
      load({ w: 8, h: 6, doors: [{ side: 'n', offset: 3 }], furniture: [p({ x: 0, y: 1 }), p({ kind: 'desk', x: 3, y: 1, w: 2, h: 1 }), p({ kind: 'lamp', x: 5, y: 3 })] });
      noPinIssues();
      for (let step = 0; step < 300; step++) {
        const count = pins()?.length ?? 0;
        const index = Math.floor(rnd() * Math.max(1, count));
        const op = rnd();
        if (op < 0.45) {
          s().nudgePin('a', index, pick(steps), pick(steps));
        } else if (op < 0.85) {
          s().beginGesture();
          for (let k = 0; k < 1 + Math.floor(rnd() * 4); k++) s().setPinPos('a', index, { x: rnd() * 7 - 0.5, y: rnd() * 5 - 0.5 });
          s().endGesture();
        } else if (op < 0.95) {
          s().undo();
        } else {
          s().redo();
        }
        noPinIssues();
        for (const pin of pins() ?? []) {
          expect(Number.isInteger(pin.x * 2) && Number.isInteger(pin.y * 2)).toBe(true);
          expect(PinnedFurnitureSchema.safeParse(pin).success).toBe(true);
        }
      }
    }
  });
});

describe('editorStore door edits prune stale pins (M12 gate 2)', () => {
  beforeEach(closeStore);
  const s = () => useEditorStore.getState();
  const pins = () => s().draft?.rooms[0]?.furniture;
  const pin = (x: number, y: number) => ({ kind: 'plant', x, y, w: 1, h: 1 });
  // Room 'a': 6x5 walled -> interior 4x3; an N door at offset 2 lands on interior x 1, y 0.
  const load = (r: Partial<LayoutRoom> = {}) => s().load(layout({ rooms: [room({ walled: true, furniture: [pin(1, 0), pin(3, 2)], ...r })] }));

  it('addDoor releases the pin on the new door apron in the same undo step, notes it, and undo restores it', () => {
    load();
    s().addDoor('a', { side: 'n', offset: 2 });
    expect(pins()).toEqual([pin(3, 2)]);
    expect(s().history).toHaveLength(1);
    expect(s().pruneNotice).toEqual({ count: 1 });
    s().undo();
    expect(pins()).toHaveLength(2);
    expect(s().pruneNotice).toBeNull();
  });

  it('updateDoor, nudgeDoor, setRoomDoors and sealRoom prune too', () => {
    load({ doors: [{ side: 'n', offset: 3 }] });
    s().updateDoor('a', 0, { offset: 2 });
    expect(pins()).toEqual([pin(3, 2)]);
    s().load(layout({ rooms: [room({ walled: true, furniture: [pin(1, 0)], doors: [{ side: 'n', offset: 3 }] })] }));
    s().nudgeDoor('a', 0, -1);
    expect(pins()).toBeUndefined();
    load();
    s().setRoomDoors('a', [{ side: 'n', offset: 2 }]);
    expect(pins()).toEqual([pin(3, 2)]);
    load({ doors: [] });
    s().sealRoom('a');
    expect(pins()).toHaveLength(2); // sealing adds no door, nothing to prune
  });

  it('a door drag prunes from the pre-drag pins, so dragging off and back restores the pin', () => {
    load({ doors: [{ side: 'n', offset: 3 }] });
    s().beginGesture();
    s().setDoorRect('a', 0, { offset: 2 });
    expect(pins()).toEqual([pin(3, 2)]);
    s().setDoorRect('a', 0, { offset: 3 });
    expect(pins()).toHaveLength(2);
    s().setDoorRect('a', 0, { offset: 2 });
    s().endGesture();
    expect(s().history).toHaveLength(1);
    expect(s().pruneNotice).toEqual({ count: 1 });
  });

  it('a resize that drops pins notes them when the gesture ends', () => {
    load({ furniture: [pin(0, 0), pin(3, 2)] });
    s().beginGesture();
    s().resizeRoomTo('a', { w: 4, h: 4 });
    s().endGesture();
    expect(pins()).toEqual([pin(0, 0)]);
    expect(s().pruneNotice).toEqual({ count: 1 });
  });
});

describe('editorStore M16 furnishing: slots, ghosts, rotate, palette', () => {
  beforeEach(closeStore);
  // Room 'a': 8x7 walled -> interior 6x5.
  type Pin = import('@tagconn/shared').PinnedFurniture;
  const p = (over: Partial<Pin> = {}): Pin => ({ kind: 'plant', x: 0, y: 0, w: 1, h: 1, ...over });
  const s = () => useEditorStore.getState();
  const pins = () => s().draft?.rooms[0]?.furniture;
  const load = (r: Partial<LayoutRoom> = {}) => s().load(layout({ rooms: [room({ w: 8, h: 7, walled: true, ...r })] }));
  const noPinIssues = () => expect(validateLayout(s().draft!).filter((i) => i.code === 'pinned-invalid')).toEqual([]);

  it('a dragged generated item keeps its recipe slot as fromSlot (it is consumed, not duplicated)', () => {
    load();
    s().beginGesture();
    const idx = s().pinDirect('a', { kind: 'work-desk', x: 1, y: 1, w: 2, h: 1, fromSlot: 'desk:3' });
    s().setPinPos('a', idx, { x: 2, y: 1 });
    s().endGesture();
    expect(pins()).toEqual([{ kind: 'work-desk', x: 2, y: 1, w: 2, h: 1, fromSlot: 'desk:3' }]);
    expect(s().history).toHaveLength(1);
  });
  // Needs the generator to skip consumed slots (F5, wave 2): generateMap(draft) must keep the same number of work-desks after a drag.
  it.todo('dragging a work-desk of the desks room by a tile does not duplicate it (enabled with F5)');

  it('suppressSlot adds a ghost in one commit; undo removes it; a repeat is refused', () => {
    load();
    s().suppressSlot('a', p({ kind: 'work-desk', w: 2, fromSlot: 'desk:0' }));
    expect(pins()).toEqual([p({ kind: 'work-desk', w: 2, fromSlot: 'desk:0', suppressed: true })]);
    expect(s().history).toHaveLength(1);
    s().suppressSlot('a', p({ kind: 'work-desk', w: 2, fromSlot: 'desk:0' }));
    expect(pins()).toHaveLength(1);
    s().undo();
    expect(pins()).toBeUndefined();
    s().redo();
    expect(pins()).toHaveLength(1);
    noPinIssues();
  });

  it('suppressSlot refuses stairs, unknown/prototype kinds and pins without a slot', () => {
    load();
    s().suppressSlot('a', p({ kind: 'stairs-up', fromSlot: 'stairs:0' }));
    s().suppressSlot('a', p({ kind: 'constructor', fromSlot: 'x:0' }));
    s().suppressSlot('a', p({ kind: 'toString', fromSlot: 'x:1' }));
    s().suppressSlot('a', p({ kind: 'plant' })); // no fromSlot: nothing to consume
    expect(pins()).toBeUndefined();
    expect(s().history).toHaveLength(0);
  });

  it('ghosts count toward the 48 cap', () => {
    const full = Array.from({ length: 47 }, (_, i) => p({ kind: 'crate', x: i % 6, y: Math.floor(i / 6) % 5, suppressed: true, fromSlot: `crate:${i}` }));
    load({ furniture: full });
    s().suppressSlot('a', p({ kind: 'plant', x: 5, y: 4, fromSlot: 'plant:0' }));
    expect(pins()).toHaveLength(48);
    s().suppressSlot('a', p({ kind: 'plant', x: 5, y: 3, fromSlot: 'plant:1' }));
    s().addPin('a', p({ kind: 'plant', x: 4, y: 4 }));
    expect(pins()).toHaveLength(48);
  });

  it('a ghost blocks nothing: a real pin may sit on it, and it can neither move nor rotate', () => {
    load({ furniture: [p({ kind: 'chair', x: 1, y: 1, suppressed: true, fromSlot: 'chair:0' })] });
    s().addPin('a', p({ kind: 'lamp', x: 1, y: 1 }));
    expect(pins()).toHaveLength(2);
    s().nudgePin('a', 0, 1, 0);
    s().rotatePin('a', 0);
    expect(pins()?.[0]).toMatchObject({ x: 1, y: 1 });
    expect(pins()?.[0]?.facing).toBeUndefined();
    noPinIssues();
  });

  it('restoreSlot removes the ghost in one commit and ignores a real pin', () => {
    load({ furniture: [p({ x: 3 }), p({ kind: 'chair', suppressed: true, fromSlot: 'chair:0' })] });
    s().restoreSlot('a', 0);
    expect(pins()).toHaveLength(2);
    s().restoreSlot('a', 1);
    expect(pins()).toEqual([p({ x: 3 })]);
    expect(s().history).toHaveLength(1);
    s().undo();
    expect(pins()).toHaveLength(2);
  });

  it('rotatePin cycles facing with the w/h swap, one commit each, and undoes', () => {
    load({ furniture: [p({ kind: 'bench', x: 1, y: 1, w: 2, h: 1 })] });
    s().rotatePin('a', 0);
    expect(pins()?.[0]).toMatchObject({ facing: 'w', w: 1, h: 2 }); // s -> w -> n -> e
    expect(s().history).toHaveLength(1);
    s().rotatePin('a', 0);
    expect(pins()?.[0]).toMatchObject({ facing: 'n', w: 2, h: 1 });
    s().undo();
    expect(pins()?.[0]).toMatchObject({ facing: 'w', w: 1, h: 2 });
    noPinIssues();
  });

  it('rotatePin is refused (nothing changes) when the rotated rect does not fit, or the kind is fixed', () => {
    load({ furniture: [p({ kind: 'bench', x: 0, y: 0, w: 2, h: 1 }), p({ kind: 'crate', x: 0, y: 1 })] });
    s().rotatePin('a', 0); // 1x2 would cover (0,1): the crate
    expect(pins()?.[0]).toMatchObject({ w: 2, h: 1 });
    expect(pins()?.[0]?.facing).toBeUndefined();
    expect(s().history).toHaveLength(0);
    load({ furniture: [p({ kind: 'work-desk', w: 2 })] });
    s().rotatePin('a', 0);
    expect(s().history).toHaveLength(0);
  });

  it('rotateGenerated locks the item already rotated, keeping its slot, in one commit', () => {
    load();
    s().rotateGenerated('a', p({ kind: 'sofa', x: 1, y: 1, w: 3, h: 1, fromSlot: 'sofa:0' }));
    expect(pins()).toEqual([expect.objectContaining({ kind: 'sofa', facing: 'w', w: 1, h: 3, fromSlot: 'sofa:0' })]);
    expect(s().history).toHaveLength(1);
    expect(s().selectedFurniture).toEqual({ roomId: 'a', pinIndex: 0 });
    s().undo();
    expect(pins()).toBeUndefined();
  });

  it('rotatePin to a given facing (inspector control) only accepts supported facings', () => {
    load({ furniture: [p({ kind: 'bench', x: 1, y: 1, w: 2, h: 1 })] });
    s().rotatePin('a', 0, 'w');
    expect(pins()?.[0]).toMatchObject({ facing: 'w', w: 1, h: 2 });
    load({ furniture: [p({ kind: 'work-desk', w: 2 })] });
    s().rotatePin('a', 0, 'n');
    expect(pins()?.[0]?.facing).toBeUndefined();
  });

  it('addPin places a free pin in one commit, selects it, and refuses an overlap, stairs or a builtin', () => {
    load({ furniture: [p()] });
    s().addPin('a', p({ kind: 'sofa', x: 1, y: 2, w: 3 }));
    expect(pins()).toHaveLength(2);
    expect(s().selectedFurniture).toEqual({ roomId: 'a', pinIndex: 1 });
    expect(s().history).toHaveLength(1);
    s().addPin('a', p({ kind: 'lamp', x: 1, y: 2 })); // overlaps the sofa
    s().addPin('a', p({ kind: 'stairs-up', x: 5, y: 4 }));
    expect(pins()).toHaveLength(2);
    s().load(layout({ builtin: true, rooms: [room({ w: 8, h: 7 })] }));
    s().addPin('a', p({ x: 1, y: 1 }));
    expect(pins()).toBeUndefined();
  });

  it('placing is armed by the palette and cleared by a tool change, load and close', () => {
    load();
    s().setTool('furniture');
    s().setPlacing({ kind: 'plant', w: 1, h: 1 });
    expect(s().placing).toEqual({ kind: 'plant', w: 1, h: 1 });
    s().setTool('select');
    expect(s().placing).toBeNull();
    s().setTool('furniture');
    s().setPlacing({ kind: 'plant', w: 1, h: 1 });
    s().close();
    expect(s().placing).toBeNull();
  });

  it('shrinking the room drops a ghost only when it leaves the interior (never over a door apron)', () => {
    load({ doors: [{ side: 'n', offset: 2 }], furniture: [p({ kind: 'chair', x: 1, y: 0, suppressed: true, fromSlot: 'chair:0' }), p({ x: 5, y: 4 })] });
    expect(pins()).toHaveLength(2); // the ghost on the door apron stays
    s().updateRoom('a', { w: 6, h: 5 }); // interior 4x3: the pin at (5,4) leaves, the ghost stays
    expect(pins()).toEqual([expect.objectContaining({ suppressed: true })]);
    noPinIssues();
  });

  it('lockFurniture does not treat a ghost at the same rect as an existing pin', () => {
    load({ furniture: [p({ kind: 'chair', x: 1, y: 1, suppressed: true, fromSlot: 'chair:0' })] });
    s().lockFurniture('a', p({ kind: 'chair', x: 1, y: 1 }));
    expect(pins()).toHaveLength(2);
  });
});
