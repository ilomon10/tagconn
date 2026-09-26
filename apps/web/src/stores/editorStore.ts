import { create } from 'zustand';
import { LAYOUT_LIMITS, type DoorSpec, type LayoutBackground, type LayoutRoom, type OfficeLayout, type OfficeLayoutInput, type OfficeStyle, type RoomFurnish, type RoomType } from '@tagconn/shared';

/**
 * Hall Planner draft state (7e-A, docs/design/guild-hall.md section 5). The draft is an
 * `OfficeLayoutInput` (the exact shape the server accepts), plus editor-only bookkeeping: which
 * saved layout (if any) it started from, whether that layout is a read-only builtin, undo/redo
 * history, the current tool and selection.
 *
 * Undo model: most actions are one call = one history entry ("commit"). Drags and resizes are a
 * gesture: `beginGesture()` snapshots the pre-drag draft, then any number of `moveRoomsBy` /
 * `resizeRoomTo` calls mutate the draft directly with no history entries, and `endGesture()` pushes
 * exactly one entry (the pre-drag snapshot) if anything actually changed.
 */

export type EditorTool = 'select' | 'room' | 'stairs' | 'hand' | 'doors';

const HISTORY_LIMIT = 100;

/** Merges a patch into an optional furnish-like object, dropping any key explicitly patched to
 * `undefined` ("use the default") and collapsing back to `undefined` once nothing is left set. */
function mergeFurnish<T extends Record<string, unknown>>(base: T | undefined, patch: Partial<T>): T | undefined {
  const next = { ...(base ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return Object.keys(next).length ? (next as T) : undefined;
}

/** Room ids only need to be unique within a layout; short and readable is enough. */
export function genRoomId(): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `r-${rand.replace(/-/g, '').slice(0, 10)}`;
}

const emptyDraft = (over: Partial<OfficeLayoutInput> = {}): OfficeLayoutInput => ({
  name: 'New Floor',
  width: 48,
  height: 30,
  seed: 1,
  background: 'hall',
  corridorWidth: 2,
  rooms: [],
  ...over,
});

const cap = <T>(arr: T[], limit: number): T[] => (arr.length > limit ? arr.slice(arr.length - limit) : arr);

/**
 * Fills in the server-owned fields (`id`, `builtin`, timestamps) so an in-progress draft can be fed
 * to `generateMap` (which takes a full `OfficeLayout`) — geometry never depends on style (D2), so
 * these placeholders are safe for a live preview/plan-canvas render that never gets saved as-is.
 */
export function draftAsLayout(input: OfficeLayoutInput): OfficeLayout {
  return {
    ...input,
    id: input.id ?? 'draft',
    background: input.background ?? 'hall',
    corridorWidth: input.corridorWidth ?? 2,
    builtin: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

export interface EditorState {
  /** null while the editor is closed / nothing loaded yet. */
  draft: OfficeLayoutInput | null;
  /** The id of the saved layout this draft started from; undefined for a brand-new, unsaved layout. */
  originalId?: string;
  /**
   * The saved layout's `updatedAt` as of the last `load()`/`applySaved()` — sent back as
   * `baseUpdatedAt` on the next save so the server can 409 if someone else saved (or deleted) it in
   * the meantime, instead of silently overwriting them. Undefined for a brand-new, unsaved layout.
   */
  originalUpdatedAt?: number;
  /** True while editing a read-only builtin — mutating actions no-op until `duplicateAsEditable()`. */
  builtin: boolean;
  dirty: boolean;
  selection: string[];
  /** The door tool's current pick: a room id + index into that room's now-explicit `doors` list. */
  selectedDoor: { roomId: string; index: number } | null;
  tool: EditorTool;
  /** Room type the Room tool stamps next (remembers the last pick; Stairs tool forces 'stairs'). */
  pendingRoomType: RoomType;
  history: OfficeLayoutInput[];
  future: OfficeLayoutInput[];
  /** Pre-gesture snapshot, set by `beginGesture()` and consumed by `endGesture()`. */
  gestureBaseline: OfficeLayoutInput | null;

  load(layout: OfficeLayout): void;
  createNew(opts?: { width?: number; height?: number; background?: LayoutBackground; name?: string }): void;
  close(): void;

  setMeta(patch: Partial<Pick<OfficeLayoutInput, 'name' | 'width' | 'height' | 'seed' | 'background' | 'corridorWidth' | 'style'>>): void;
  /** Layout-wide furnishing defaults (M8 8n) — merged; a key patched to `undefined` clears it. */
  setFurnishDefaults(patch: Partial<NonNullable<OfficeLayoutInput['furnishDefaults']>>): void;
  addRoom(room: LayoutRoom): void;
  updateRoom(id: string, patch: Partial<Omit<LayoutRoom, 'id'>>): void;
  removeRooms(ids: string[]): void;
  duplicateRooms(ids: string[]): void;

  /** Merges a patch into a room's furnish overrides; a key patched to `undefined` falls back
   * (layout default, then built-in). */
  setRoomFurnish(roomId: string, patch: Partial<RoomFurnish>): void;
  /** "Reset to defaults": clears every override for this room. */
  resetRoomFurnish(roomId: string): void;
  /** "Re-roll arrangement": a fresh `furnish.seed`, keeping every other furnish field as-is. */
  rerollRoomSeed(roomId: string): void;

  /** Replaces this room's door list wholesale; `undefined` restores automatic doors, `[]` seals it. */
  setRoomDoors(roomId: string, doors: DoorSpec[] | undefined): void;
  /** Convenience for "Seal room": `setRoomDoors(roomId, [])`. */
  sealRoom(roomId: string): void;
  /** First edit on a room with automatic doors: freezes `autoDoors` (from `GeneratedMap`) into an
   * explicit list, so nothing jumps once the user starts dragging/adding/removing doors. No-op if
   * the room already has an explicit list (including a sealed `[]`). */
  ensureExplicitDoors(roomId: string, autoDoors: DoorSpec[]): void;
  /** Appends a door, materializing `autoDoors` first if the room was still automatic. */
  addDoor(roomId: string, door: DoorSpec, autoDoors?: DoorSpec[]): void;
  /** Patches one door (move/resize), materializing `autoDoors` first if needed. */
  updateDoor(roomId: string, index: number, patch: Partial<DoorSpec>, autoDoors?: DoorSpec[]): void;
  /** Removes one door (materializing `autoDoors` first if needed) and clears the selection if it pointed at it. */
  removeDoor(roomId: string, index: number, autoDoors?: DoorSpec[]): void;
  /** One-commit keyboard nudge of the selected door along its wall, clamped to stay inside the corners. */
  nudgeDoor(roomId: string, index: number, delta: number): void;
  /** Direct-mutate (no history entry) door move/resize — pair with `beginGesture()`/`endGesture()`.
   * Requires the room's doors to already be explicit (call `ensureExplicitDoors` first). */
  setDoorRect(roomId: string, index: number, rect: Partial<Pick<DoorSpec, 'offset' | 'width'>>): void;
  selectDoor(roomId: string, index: number): void;
  clearDoorSelection(): void;
  /** Replaces the whole draft as one undo step (e.g. "Surprise me"). Keeps id/name unless overridden. */
  replaceDraft(input: OfficeLayoutInput): void;
  /** Converts a read-only builtin draft into an editable, unsaved copy ("Duplicate to edit"). */
  duplicateAsEditable(newName?: string): void;
  /** Reconciles the draft with what the server actually saved (id, timestamps, normalized fields). */
  applySaved(saved: OfficeLayout): void;

  select(ids: string[], additive?: boolean): void;
  clearSelection(): void;
  setTool(tool: EditorTool): void;
  setPendingRoomType(type: RoomType): void;

  beginGesture(): void;
  moveRoomsBy(ids: string[], dx: number, dy: number): void;
  resizeRoomTo(id: string, rect: Partial<Pick<LayoutRoom, 'x' | 'y' | 'w' | 'h'>>): void;
  endGesture(): void;
  /** Esc mid-drag: restore the pre-gesture draft instead of committing it. */
  cancelGesture(): void;
  /** One commit per call — used for the keyboard nudge (arrow / shift+arrow). */
  nudgeSelection(dx: number, dy: number): void;

  undo(): void;
  redo(): void;
}

export const useEditorStore = create<EditorState>()((set, get) => {
  /** Push `prev` onto the undo history (capped) and clear redo — call before installing a new draft. */
  const commit = (prev: OfficeLayoutInput, next: OfficeLayoutInput) =>
    set((s) => ({ draft: next, history: cap([...s.history, prev], HISTORY_LIMIT), future: [], dirty: true }));

  const mutateRooms = (fn: (rooms: LayoutRoom[]) => LayoutRoom[]) => {
    const s = get();
    if (!s.draft || s.builtin) return;
    const prev = s.draft;
    const next = { ...prev, rooms: fn(prev.rooms) };
    commit(prev, next);
  };

  return {
    draft: null,
    originalId: undefined,
    originalUpdatedAt: undefined,
    builtin: false,
    dirty: false,
    selection: [],
    selectedDoor: null,
    tool: 'select',
    pendingRoomType: 'desks',
    history: [],
    future: [],
    gestureBaseline: null,

    load: (layout) =>
      set({
        draft: { ...layout },
        originalId: layout.id,
        originalUpdatedAt: layout.updatedAt,
        builtin: layout.builtin,
        dirty: false,
        selection: [],
        selectedDoor: null,
        tool: 'select',
        history: [],
        future: [],
        gestureBaseline: null,
      }),

    createNew: (opts = {}) =>
      set({
        draft: emptyDraft(opts),
        originalId: undefined,
        originalUpdatedAt: undefined,
        builtin: false,
        dirty: true,
        selection: [],
        selectedDoor: null,
        tool: 'select',
        history: [],
        future: [],
        gestureBaseline: null,
      }),

    close: () =>
      set({
        draft: null,
        originalId: undefined,
        originalUpdatedAt: undefined,
        builtin: false,
        dirty: false,
        selection: [],
        selectedDoor: null,
        tool: 'select',
        history: [],
        future: [],
        gestureBaseline: null,
      }),

    setMeta: (patch) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      commit(s.draft, { ...s.draft, ...patch });
    },

    setFurnishDefaults: (patch) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      commit(s.draft, { ...s.draft, furnishDefaults: mergeFurnish(s.draft.furnishDefaults, patch) });
    },

    addRoom: (room) => mutateRooms((rooms) => [...rooms, room]),

    updateRoom: (id, patch) => mutateRooms((rooms) => rooms.map((r) => (r.id === id ? { ...r, ...patch } : r))),

    removeRooms: (ids) => {
      const remove = new Set(ids);
      mutateRooms((rooms) => rooms.filter((r) => !remove.has(r.id)));
      set((s) => ({
        selection: s.selection.filter((id) => !remove.has(id)),
        selectedDoor: s.selectedDoor && remove.has(s.selectedDoor.roomId) ? null : s.selectedDoor,
      }));
    },

    setRoomFurnish: (roomId, patch) =>
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, furnish: mergeFurnish(r.furnish, patch) } : r))),

    resetRoomFurnish: (roomId) => mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, furnish: undefined } : r))),

    rerollRoomSeed: (roomId) =>
      mutateRooms((rooms) =>
        rooms.map((r) => (r.id === roomId ? { ...r, furnish: { ...r.furnish, seed: Math.floor(Math.random() * 0xffffffff) } } : r)),
      ),

    setRoomDoors: (roomId, doors) => {
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: doors ? doors.slice() : undefined } : r)));
      set((s) => (s.selectedDoor?.roomId === roomId ? { selectedDoor: null } : {}));
    },

    sealRoom: (roomId) => {
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: [] } : r)));
      set((s) => (s.selectedDoor?.roomId === roomId ? { selectedDoor: null } : {}));
    },

    ensureExplicitDoors: (roomId, autoDoors) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room || room.doors !== undefined) return; // already explicit (including sealed [])
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: autoDoors.slice() } : r)));
    },

    addDoor: (roomId, door, autoDoors = []) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room) return;
      const current = room.doors ?? autoDoors;
      if (current.length >= LAYOUT_LIMITS.maxDoorsPerRoom) return;
      const next = [...current, door];
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: next } : r)));
    },

    updateDoor: (roomId, index, patch, autoDoors = []) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      const current = room?.doors ?? autoDoors;
      if (!room || !current[index]) return;
      const next = current.slice();
      next[index] = { ...next[index]!, ...patch };
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: next } : r)));
    },

    removeDoor: (roomId, index, autoDoors = []) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      const current = room?.doors ?? autoDoors;
      if (!room || !current[index]) return;
      const next = current.filter((_, i) => i !== index);
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: next } : r)));
      set((st) => (st.selectedDoor?.roomId === roomId && st.selectedDoor.index === index ? { selectedDoor: null } : {}));
    },

    nudgeDoor: (roomId, index, delta) => {
      const s = get();
      if (!s.draft || s.builtin || delta === 0) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      const door = room?.doors?.[index];
      if (!room || !door) return;
      const len = door.side === 'n' || door.side === 's' ? room.w : room.h;
      const width = door.width ?? 1;
      const offset = Math.max(1, Math.min(len - 1 - width, door.offset + delta));
      if (offset === door.offset) return;
      mutateRooms((rooms) =>
        rooms.map((r) => (r.id === roomId ? { ...r, doors: r.doors!.map((d, i) => (i === index ? { ...d, offset } : d)) } : r)),
      );
    },

    setDoorRect: (roomId, index, rect) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      set({
        draft: {
          ...s.draft,
          rooms: s.draft.rooms.map((r) => {
            if (r.id !== roomId || !r.doors?.[index]) return r;
            const doors = r.doors.slice();
            doors[index] = { ...doors[index]!, ...rect };
            return { ...r, doors };
          }),
        },
      });
    },

    selectDoor: (roomId, index) => set({ selectedDoor: { roomId, index } }),
    clearDoorSelection: () => set({ selectedDoor: null }),

    duplicateRooms: (ids) => {
      const want = new Set(ids);
      const s = get();
      if (!s.draft || s.builtin) return;
      const clones = s.draft.rooms.filter((r) => want.has(r.id)).map((r) => ({ ...r, id: genRoomId(), x: r.x + 1, y: r.y + 1 }));
      if (clones.length === 0) return;
      const prev = s.draft;
      commit(prev, { ...prev, rooms: [...prev.rooms, ...clones] });
      set({ selection: clones.map((c) => c.id) });
    },

    replaceDraft: (input) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      commit(s.draft, input);
      set({ selection: [], selectedDoor: null });
    },

    duplicateAsEditable: (newName) => {
      const s = get();
      if (!s.draft) return;
      set({
        draft: { ...s.draft, id: undefined, name: newName ?? `${s.draft.name} copy` },
        originalId: undefined,
        originalUpdatedAt: undefined,
        builtin: false,
        dirty: true,
        history: [],
        future: [],
        gestureBaseline: null,
        selectedDoor: null,
      });
    },

    applySaved: (saved) =>
      set({ draft: { ...saved }, originalId: saved.id, originalUpdatedAt: saved.updatedAt, builtin: saved.builtin, dirty: false }),

    select: (ids, additive) =>
      set((s) =>
        additive ? { selection: [...new Set([...s.selection, ...ids])] } : { selection: [...new Set(ids)], selectedDoor: null },
      ),
    clearSelection: () => set({ selection: [] }),
    setTool: (tool) => set((s) => ({ tool, selectedDoor: tool === 'doors' ? s.selectedDoor : null })),
    setPendingRoomType: (type) => set({ pendingRoomType: type }),

    beginGesture: () => {
      const s = get();
      if (s.gestureBaseline || !s.draft || s.builtin) return;
      set({ gestureBaseline: s.draft });
    },

    moveRoomsBy: (ids, dx, dy) => {
      const s = get();
      if (!s.draft || s.builtin || (dx === 0 && dy === 0)) return;
      const move = new Set(ids);
      set({ draft: { ...s.draft, rooms: s.draft.rooms.map((r) => (move.has(r.id) ? { ...r, x: r.x + dx, y: r.y + dy } : r)) } });
    },

    resizeRoomTo: (id, rect) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      set({ draft: { ...s.draft, rooms: s.draft.rooms.map((r) => (r.id === id ? { ...r, ...rect } : r)) } });
    },

    endGesture: () => {
      const s = get();
      const baseline = s.gestureBaseline;
      set({ gestureBaseline: null });
      // Skip the history entry if the gesture ended back where it started (e.g. a drag out and back).
      if (!baseline || !s.draft || JSON.stringify(baseline) === JSON.stringify(s.draft)) return;
      set((s2) => ({ history: cap([...s2.history, baseline], HISTORY_LIMIT), future: [], dirty: true }));
    },

    cancelGesture: () => {
      const s = get();
      if (!s.gestureBaseline) return;
      set({ draft: s.gestureBaseline, gestureBaseline: null });
    },

    nudgeSelection: (dx, dy) => {
      const s = get();
      if (!s.draft || s.builtin || s.selection.length === 0 || (dx === 0 && dy === 0)) return;
      const move = new Set(s.selection);
      const prev = s.draft;
      const next = { ...prev, rooms: prev.rooms.map((r) => (move.has(r.id) ? { ...r, x: r.x + dx, y: r.y + dy } : r)) };
      commit(prev, next);
    },

    undo: () => {
      const s = get();
      if (s.history.length === 0 || !s.draft) return;
      const prevDraft = s.history[s.history.length - 1]!;
      set({ draft: prevDraft, history: s.history.slice(0, -1), future: cap([s.draft, ...s.future], HISTORY_LIMIT), dirty: true });
    },
    redo: () => {
      const s = get();
      if (s.future.length === 0 || !s.draft) return;
      const nextDraft = s.future[0]!;
      set({ draft: nextDraft, future: s.future.slice(1), history: cap([...s.history, s.draft], HISTORY_LIMIT), dirty: true });
    },
  };
});
