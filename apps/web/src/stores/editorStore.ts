import { create } from 'zustand';
import { LAYOUT_LIMITS, type DoorSpec, type Facing, type LayoutBackground, type LayoutRoom, type OfficeLayout, type OfficeLayoutInput, type OfficeStyle, type PinnedFurniture, type RoomFurnish, type RoomType } from '@tagconn/shared';
import { clampPinPos, isPinnableKind, isSuppressibleKind, pinFits, prunePins, rotatedPin } from '../features/editor/pins';

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

export type EditorTool = 'select' | 'room' | 'stairs' | 'hand' | 'doors' | 'furniture';

/** The Furniture tool's pick: a pin (index into the room's `furniture`) or a generated item not locked yet (interior-relative). */
export type FurnitureSelection = { roomId: string; pinIndex: number } | { roomId: string; generated: PinnedFurniture };

/** Drops a furniture selection that no longer points at anything (room gone, pin removed, e.g. after undo). */
function reconcileFurnitureSelection(draft: OfficeLayoutInput | null, sel: FurnitureSelection | null): FurnitureSelection | null {
  if (!sel || !draft) return null;
  const room = draft.rooms.find((r) => r.id === sel.roomId);
  if (!room) return null;
  if ('pinIndex' in sel && !room.furniture?.[sel.pinIndex]) return null;
  return sel;
}

/** The palette's armed kind: the next click on a room's interior drops a free pin of this size (M16, furnishing.md section 6.3). */
export interface Placing {
  kind: string;
  w: number;
  h: number;
}

/** True when `p` is the same real (non-ghost) item as `pin`: same kind and rect. */
const samePin = (p: PinnedFurniture, pin: PinnedFurniture) => !p.suppressed && p.kind === pin.kind && p.x === pin.x && p.y === pin.y && p.w === pin.w && p.h === pin.h;

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
  /** The Furniture tool's current pick (M12); see `FurnitureSelection`. */
  selectedFurniture: FurnitureSelection | null;
  /** How many locked items the last room edit released because they no longer fit; cleared by the next edit, undo or redo. */
  pruneNotice: { count: number } | null;
  tool: EditorTool;
  /** The palette's armed free pin (M16), or null; cleared by Esc, a tool change, load and close. */
  placing: Placing | null;
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

  /** Selects a furniture item (and its room); `null` clears just the furniture pick. */
  selectFurniture(sel: FurnitureSelection | null): void;
  /** Locks a generated item as a pin (one commit); no-op if an identical pin exists, it does not fit, or the cap is reached. Selects the new pin. */
  lockFurniture(roomId: string, pin: PinnedFurniture): void;
  /** Gesture-only (pair with `beginGesture()`/`endGesture()`): appends the pin without a history entry and returns its index (the existing index if identical; -1 if refused). */
  pinDirect(roomId: string, pin: PinnedFurniture): number;
  /** Gesture-only: moves a pin, snapped to half tiles (M15) and clamped to the interior; a position that overlaps another pin or an explicit door apron is refused (the pin stays). */
  setPinPos(roomId: string, index: number, pos: { x: number; y: number }): void;
  /** One-commit keyboard nudge of a pin (whole or half tiles), clamped to the interior; refused if it would overlap or block a door. */
  nudgePin(roomId: string, index: number, dx: number, dy: number): void;
  /** Releases a pin back to procedural generation (one commit); clears the selection if it pointed at it. */
  releasePin(roomId: string, index: number): void;
  /** M16: "delete" a generated item: a ghost pin (`suppressed`, with `fromSlot`) so the next generation places nothing there; one commit. Refused for non-pinnable/unknown kinds, a pin without a slot, a repeat, or a full room (ghosts count toward the cap). */
  suppressSlot(roomId: string, pin: PinnedFurniture): void;
  /** M16: removes a ghost pin so its slot generates again (one commit); no-op on a real pin. */
  restoreSlot(roomId: string, index: number): void;
  /** M16: R on a pin: next facing with the w/h swap, one commit; refused (nothing changes) when the rotated rect does not fit or the kind is fixed. */
  rotatePin(roomId: string, index: number, to?: Facing): void;
  /** M16: R on a generated item: locks it (keeping `fromSlot`) already rotated, in one commit; same refusals as `rotatePin`. */
  rotateGenerated(roomId: string, pin: PinnedFurniture, to?: Facing): void;
  /** M16: palette placement of a free pin (one commit, selected afterwards); refused when it does not fit, the kind is not pinnable, or the cap is reached. */
  addPin(roomId: string, pin: PinnedFurniture): void;
  setPlacing(p: Placing | null): void;
  /** Locks many generated items at once (one commit); invalid or overlapping ones are skipped, the cap holds. */
  lockAll(roomId: string, pins: PinnedFurniture[]): void;
  /** Releases every pin of the room (one commit). */
  releaseAll(roomId: string): void;
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
    set((s) => ({
      draft: next,
      history: cap([...s.history, prev], HISTORY_LIMIT),
      future: [],
      dirty: true,
      selectedFurniture: reconcileFurnitureSelection(next, s.selectedFurniture),
      pruneNotice: null,
    }));

  const countPins = (d: OfficeLayoutInput) => d.rooms.reduce((n, r) => n + (r.furniture?.length ?? 0), 0);

  /** `prune`: drop pins the edit made stale (resize, type, walled, doors) inside the same undo step, and note how many. */
  const mutateRooms = (fn: (rooms: LayoutRoom[]) => LayoutRoom[], opts: { prune?: boolean } = {}) => {
    const s = get();
    if (!s.draft || s.builtin) return;
    const prev = s.draft;
    const rooms = opts.prune ? fn(prev.rooms).map((r) => prunePins(r)) : fn(prev.rooms);
    const next = { ...prev, rooms };
    commit(prev, next);
    const released = countPins(prev) - countPins(next);
    if (opts.prune && released > 0) set({ pruneNotice: { count: released } });
  };

  /** Replaces one room's pin list as one commit; `undefined`/empty clears it. */
  const setPins = (roomId: string, pins: PinnedFurniture[] | undefined) =>
    mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, furniture: pins?.length ? pins : undefined } : r)));

  return {
    draft: null,
    originalId: undefined,
    originalUpdatedAt: undefined,
    builtin: false,
    dirty: false,
    selection: [],
    selectedDoor: null,
    selectedFurniture: null,
    pruneNotice: null,
    tool: 'select',
    placing: null,
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
        selectedFurniture: null,
        pruneNotice: null,
        tool: 'select',
        placing: null,
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
        selectedFurniture: null,
        pruneNotice: null,
        tool: 'select',
        placing: null,
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
        selectedFurniture: null,
        pruneNotice: null,
        tool: 'select',
        placing: null,
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

    // Pins that no longer fit the changed room (size, type, walled, doors) are dropped, so a draft never fails validateLayout over them.
    updateRoom: (id, patch) => mutateRooms((rooms) => rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)), { prune: true }),

    removeRooms: (ids) => {
      const remove = new Set(ids);
      mutateRooms((rooms) => rooms.filter((r) => !remove.has(r.id)));
      set((s) => ({
        selection: s.selection.filter((id) => !remove.has(id)),
        selectedDoor: s.selectedDoor && remove.has(s.selectedDoor.roomId) ? null : s.selectedDoor,
        selectedFurniture: s.selectedFurniture && remove.has(s.selectedFurniture.roomId) ? null : s.selectedFurniture,
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
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: doors ? doors.slice() : undefined } : r)), { prune: true });
      set((s) => (s.selectedDoor?.roomId === roomId ? { selectedDoor: null } : {}));
    },

    sealRoom: (roomId) => {
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: [] } : r)), { prune: true });
      set((s) => (s.selectedDoor?.roomId === roomId ? { selectedDoor: null } : {}));
    },

    ensureExplicitDoors: (roomId, autoDoors) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room || room.doors !== undefined) return; // already explicit (including sealed [])
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: autoDoors.slice() } : r)), { prune: true });
    },

    addDoor: (roomId, door, autoDoors = []) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room) return;
      const current = room.doors ?? autoDoors;
      if (current.length >= LAYOUT_LIMITS.maxDoorsPerRoom) return;
      const next = [...current, door];
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: next } : r)), { prune: true });
    },

    updateDoor: (roomId, index, patch, autoDoors = []) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      const current = room?.doors ?? autoDoors;
      if (!room || !current[index]) return;
      const next = current.slice();
      next[index] = { ...next[index]!, ...patch };
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: next } : r)), { prune: true });
    },

    removeDoor: (roomId, index, autoDoors = []) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      const current = room?.doors ?? autoDoors;
      if (!room || !current[index]) return;
      const next = current.filter((_, i) => i !== index);
      mutateRooms((rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: next } : r)), { prune: true });
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
      mutateRooms(
        (rooms) => rooms.map((r) => (r.id === roomId ? { ...r, doors: r.doors!.map((d, i) => (i === index ? { ...d, offset } : d)) } : r)),
        { prune: true },
      );
    },

    setDoorRect: (roomId, index, rect) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      // Prune from the pre-drag pins (as resizeRoomTo does) so dragging a door off a pin and back restores it.
      const base = s.gestureBaseline?.rooms.find((r) => r.id === roomId)?.furniture;
      set({
        draft: {
          ...s.draft,
          rooms: s.draft.rooms.map((r) => {
            if (r.id !== roomId || !r.doors?.[index]) return r;
            const doors = r.doors.slice();
            doors[index] = { ...doors[index]!, ...rect };
            return prunePins({ ...r, doors }, base ?? r.furniture);
          }),
        },
      });
    },

    selectDoor: (roomId, index) => set({ selectedDoor: { roomId, index } }),
    clearDoorSelection: () => set({ selectedDoor: null }),

    selectFurniture: (sel) => set(sel ? { selectedFurniture: sel, selection: [sel.roomId], selectedDoor: null } : { selectedFurniture: null }),

    lockFurniture: (roomId, pin) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room) return;
      const pins = room.furniture ?? [];
      const same = pins.findIndex((p) => samePin(p, pin));
      if (same >= 0) {
        set({ selectedFurniture: { roomId, pinIndex: same } });
        return;
      }
      if (pins.length >= LAYOUT_LIMITS.maxPinnedPerRoom || !pinFits(room, pin)) return;
      setPins(roomId, [...pins, pin]);
      set({ selectedFurniture: { roomId, pinIndex: pins.length } });
    },

    pinDirect: (roomId, pin) => {
      const s = get();
      if (!s.draft || s.builtin) return -1;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room) return -1;
      const pins = room.furniture ?? [];
      const same = pins.findIndex((p) => samePin(p, pin));
      if (same >= 0) return same;
      if (pins.length >= LAYOUT_LIMITS.maxPinnedPerRoom || !pinFits(room, pin)) return -1;
      set({
        draft: { ...s.draft, rooms: s.draft.rooms.map((r) => (r.id === roomId ? { ...r, furniture: [...pins, pin] } : r)) },
        selectedFurniture: { roomId, pinIndex: pins.length },
      });
      return pins.length;
    },

    setPinPos: (roomId, index, pos) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      const pin = room?.furniture?.[index];
      if (!room || !pin || pin.suppressed) return; // a ghost is never movable
      const at = clampPinPos(room, pin, pos);
      if ((at.x === pin.x && at.y === pin.y) || !pinFits(room, { ...pin, ...at }, index)) return;
      set({
        draft: {
          ...s.draft,
          rooms: s.draft.rooms.map((r) => (r.id === roomId ? { ...r, furniture: r.furniture!.map((p, i) => (i === index ? { ...p, ...at } : p)) } : r)),
        },
      });
    },

    nudgePin: (roomId, index, dx, dy) => {
      const s = get();
      if (!s.draft || s.builtin || (dx === 0 && dy === 0)) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      const pin = room?.furniture?.[index];
      if (!room || !pin || pin.suppressed) return;
      const at = clampPinPos(room, pin, { x: pin.x + dx, y: pin.y + dy });
      if ((at.x === pin.x && at.y === pin.y) || !pinFits(room, { ...pin, ...at }, index)) return;
      setPins(roomId, room.furniture!.map((p, i) => (i === index ? { ...p, ...at } : p)));
    },

    releasePin: (roomId, index) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room?.furniture?.[index]) return;
      setPins(roomId, room.furniture.filter((_, i) => i !== index));
      set((st) => (st.selectedFurniture && st.selectedFurniture.roomId === roomId && 'pinIndex' in st.selectedFurniture ? { selectedFurniture: null } : {}));
    },

    suppressSlot: (roomId, pin) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room || !isSuppressibleKind(pin.kind) || !pin.fromSlot) return;
      const ghost: PinnedFurniture = { ...pin, suppressed: true };
      const pins = room.furniture ?? [];
      if (pins.length >= LAYOUT_LIMITS.maxPinnedPerRoom || pins.some((p) => p.suppressed && p.fromSlot === ghost.fromSlot) || !pinFits(room, ghost)) return;
      setPins(roomId, [...pins, ghost]);
      set({ selectedFurniture: null });
    },

    restoreSlot: (roomId, index) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room?.furniture?.[index]?.suppressed) return;
      setPins(roomId, room.furniture.filter((_, i) => i !== index));
      set((st) => (st.selectedFurniture && st.selectedFurniture.roomId === roomId && 'pinIndex' in st.selectedFurniture ? { selectedFurniture: null } : {}));
    },

    rotatePin: (roomId, index, to) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      const pin = room?.furniture?.[index];
      if (!room || !pin) return;
      const next = rotatedPin(room, pin, index, to);
      if (!next) return;
      setPins(roomId, room.furniture!.map((p, i) => (i === index ? next : p)));
    },

    rotateGenerated: (roomId, pin, to) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room) return;
      const pins = room.furniture ?? [];
      const next = rotatedPin(room, pin, undefined, to);
      if (!next || pins.length >= LAYOUT_LIMITS.maxPinnedPerRoom) return;
      setPins(roomId, [...pins, next]);
      set({ selectedFurniture: { roomId, pinIndex: pins.length } });
    },

    addPin: (roomId, pin) => {
      const s = get();
      if (!s.draft || s.builtin || !isPinnableKind(pin.kind)) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room) return;
      const pins = room.furniture ?? [];
      if (pins.length >= LAYOUT_LIMITS.maxPinnedPerRoom || pin.suppressed || !pinFits(room, pin)) return;
      setPins(roomId, [...pins, pin]);
      set({ selectedFurniture: { roomId, pinIndex: pins.length } });
    },

    setPlacing: (p) => set({ placing: p }),

    lockAll: (roomId, pins) => {
      const s = get();
      if (!s.draft || s.builtin) return;
      const room = s.draft.rooms.find((r) => r.id === roomId);
      if (!room) return;
      let probe = room;
      for (const pin of pins) {
        const cur = probe.furniture ?? [];
        if (cur.length >= LAYOUT_LIMITS.maxPinnedPerRoom) break;
        if (cur.some((p) => samePin(p, pin)) || !pinFits(probe, pin)) continue;
        probe = { ...probe, furniture: [...cur, pin] };
      }
      if (probe.furniture?.length === room.furniture?.length) return;
      setPins(roomId, probe.furniture);
    },

    releaseAll: (roomId) => {
      const s = get();
      const room = s.draft?.rooms.find((r) => r.id === roomId);
      if (!room?.furniture?.length) return;
      setPins(roomId, undefined);
      set((st) => (st.selectedFurniture?.roomId === roomId ? { selectedFurniture: null } : {}));
    },

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
      set({ selection: [], selectedDoor: null, selectedFurniture: null });
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
        selectedFurniture: null,
      });
    },

    applySaved: (saved) =>
      set({ draft: { ...saved }, originalId: saved.id, originalUpdatedAt: saved.updatedAt, builtin: saved.builtin, dirty: false }),

    select: (ids, additive) =>
      set((s) =>
        additive ? { selection: [...new Set([...s.selection, ...ids])] } : { selection: [...new Set(ids)], selectedDoor: null, selectedFurniture: null },
      ),
    clearSelection: () => set({ selection: [] }),
    setTool: (tool) =>
      set((s) => ({ tool, placing: tool === 'furniture' ? s.placing : null, selectedDoor: tool === 'doors' ? s.selectedDoor : null, selectedFurniture: tool === 'furniture' ? s.selectedFurniture : null })),
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
      // Prune from the pre-drag pins so shrinking and growing back within one drag restores them.
      const base = s.gestureBaseline?.rooms.find((r) => r.id === id)?.furniture;
      set({
        draft: { ...s.draft, rooms: s.draft.rooms.map((r) => (r.id === id ? prunePins({ ...r, ...rect }, base ?? r.furniture) : r)) },
      });
    },

    endGesture: () => {
      const s = get();
      const baseline = s.gestureBaseline;
      set({ gestureBaseline: null });
      // Skip the history entry if the gesture ended back where it started (e.g. a drag out and back).
      if (!baseline || !s.draft || JSON.stringify(baseline) === JSON.stringify(s.draft)) return;
      const released = countPins(baseline) - countPins(s.draft);
      set((s2) => ({
        history: cap([...s2.history, baseline], HISTORY_LIMIT),
        future: [],
        dirty: true,
        pruneNotice: released > 0 ? { count: released } : null,
      }));
    },

    cancelGesture: () => {
      const s = get();
      if (!s.gestureBaseline) return;
      set({ draft: s.gestureBaseline, gestureBaseline: null, pruneNotice: null, selectedFurniture: reconcileFurnitureSelection(s.gestureBaseline, s.selectedFurniture) });
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
      set({
        draft: prevDraft,
        history: s.history.slice(0, -1),
        future: cap([s.draft, ...s.future], HISTORY_LIMIT),
        dirty: true,
        pruneNotice: null,
        selectedFurniture: reconcileFurnitureSelection(prevDraft, s.selectedFurniture),
      });
    },
    redo: () => {
      const s = get();
      if (s.future.length === 0 || !s.draft) return;
      const nextDraft = s.future[0]!;
      set({
        draft: nextDraft,
        future: s.future.slice(1),
        history: cap([...s.history, s.draft], HISTORY_LIMIT),
        dirty: true,
        pruneNotice: null,
        selectedFurniture: reconcileFurnitureSelection(nextDraft, s.selectedFurniture),
      });
    },
  };
});
