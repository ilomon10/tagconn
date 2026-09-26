import { useCallback, useEffect, useRef, useState, type PointerEventHandler, type WheelEventHandler } from 'react';
import { isRoomWalled, roomInterior, type DoorSide, type DoorSpec, type LayoutIssue, type LayoutRoom, type RoomType } from '@tagconn/shared';
import type { GeneratedMap } from '../../game/procgen';
import type { ThemeDefinition } from '../../game/themes';
import { isDragMove } from '../../game/camera/drag';
import { zoomAboutPoint } from '../../game/camera/zoom';
import { genRoomId, useEditorStore } from '../../stores/editorStore';
import { autoDoorsForRoom } from './reachability';
import { RoomTypePicker } from './RoomTypePicker';

/** World pixels per tile at zoom = 1 (this is a schematic 2D plan, not the game's 16px tiles). */
const WORLD_TILE_PX = 20;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const HANDLE_HIT_PX = 7;

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'];

const ROOM_COLORS: Record<RoomType, string> = {
  entrance: '#f2c078',
  'pm-office': '#caa6f0',
  desks: '#8ecae6',
  'meeting-room': '#ffb4a2',
  whiteboard: '#a8dadc',
  'qa-lab': '#95d5b2',
  'review-booth': '#e0c3fc',
  'server-room': '#adb5bd',
  library: '#d4a373',
  lounge: '#ffd6a5',
  stairs: '#ff8fa3',
  hall: '#6c757d',
};

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DoorHandle = 'start' | 'end';

type Mode =
  | { kind: 'none' }
  | { kind: 'pan'; startScreen: { x: number; y: number }; startScroll: { x: number; y: number } }
  | { kind: 'draw'; startTile: { x: number; y: number } }
  | { kind: 'move'; lastTile: { x: number; y: number }; moved: boolean }
  | { kind: 'resize'; roomId: string; handle: Handle; anchor: Rect }
  | { kind: 'move-door'; roomId: string; index: number }
  | { kind: 'resize-door'; roomId: string; index: number; handle: DoorHandle; anchor: DoorSpec };

/** This room's doors as currently drawn: explicit if the layout has one, else the generator's auto
 * placement (from `GeneratedMap.doors`, converted to `DoorSpec`s) — `[]` with `map` missing yet. */
function effectiveDoors(map: GeneratedMap | null, room: LayoutRoom): { doors: DoorSpec[]; auto: boolean } {
  if (room.doors !== undefined) return { doors: room.doors, auto: false };
  return { doors: map ? autoDoorsForRoom(map, room) : [], auto: true };
}

/** World tiles a door occupies, in wall-ring order. */
function doorTiles(room: LayoutRoom, door: DoorSpec): { x: number; y: number }[] {
  const width = door.width ?? 1;
  const x2 = room.x + room.w - 1;
  const y2 = room.y + room.h - 1;
  const tiles: { x: number; y: number }[] = [];
  for (let i = 0; i < width; i++) {
    const o = door.offset + i;
    if (door.side === 'n') tiles.push({ x: room.x + o, y: room.y });
    else if (door.side === 's') tiles.push({ x: room.x + o, y: y2 });
    else if (door.side === 'w') tiles.push({ x: room.x, y: room.y + o });
    else tiles.push({ x: x2, y: room.y + o });
  }
  return tiles;
}

/** The first and last tile a door occupies — where its resize handles sit. */
function doorEndpoints(room: LayoutRoom, door: DoorSpec): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const tiles = doorTiles(room, door);
  return { start: tiles[0]!, end: tiles[tiles.length - 1]! };
}

/** A non-corner wall-ring tile of a walled room, with its side and offset (n/s: from x; e/w: from y) —
 * used by the Doors tool to add a door where the user clicks. */
function wallHit(rooms: readonly LayoutRoom[], tile: { x: number; y: number }): { room: LayoutRoom; side: DoorSide; offset: number } | null {
  for (let i = rooms.length - 1; i >= 0; i--) {
    const room = rooms[i]!;
    if (!isRoomWalled(room)) continue;
    const x2 = room.x + room.w - 1;
    const y2 = room.y + room.h - 1;
    if (tile.y === room.y && tile.x > room.x && tile.x < x2) return { room, side: 'n', offset: tile.x - room.x };
    if (tile.y === y2 && tile.x > room.x && tile.x < x2) return { room, side: 's', offset: tile.x - room.x };
    if (tile.x === room.x && tile.y > room.y && tile.y < y2) return { room, side: 'w', offset: tile.y - room.y };
    if (tile.x === x2 && tile.y > room.y && tile.y < y2) return { room, side: 'e', offset: tile.y - room.y };
  }
  return null;
}

/** The topmost door (any room) whose span covers this tile. */
function hitDoorAt(
  rooms: readonly LayoutRoom[],
  map: GeneratedMap | null,
  tile: { x: number; y: number },
): { room: LayoutRoom; index: number; doors: DoorSpec[] } | null {
  for (let i = rooms.length - 1; i >= 0; i--) {
    const room = rooms[i]!;
    if (!isRoomWalled(room)) continue;
    const { doors } = effectiveDoors(map, room);
    for (let j = 0; j < doors.length; j++) {
      if (doorTiles(room, doors[j]!).some((t) => t.x === tile.x && t.y === tile.y)) return { room, index: j, doors };
    }
  }
  return null;
}

export function PlanCanvas({
  generatedMap,
  issues,
  theme,
  flashRoomIds,
}: {
  generatedMap: GeneratedMap | null;
  issues: LayoutIssue[];
  theme: ThemeDefinition;
  flashRoomIds: string[];
}) {
  const store = useEditorStore();
  const { draft, selection, selectedDoor, tool, pendingRoomType, builtin } = store;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState({ zoom: 1, scrollX: 0, scrollY: 0 });
  const [drawRect, setDrawRect] = useState<Rect | null>(null);
  const [pendingPick, setPendingPick] = useState<{ rect: Rect; screen: { x: number; y: number } } | null>(null);
  const modeRef = useRef<Mode>({ kind: 'none' });
  const downRef = useRef<{ screen: { x: number; y: number }; moved: boolean } | null>(null);

  const errorRoomIds = new Set(issues.filter((i) => i.severity === 'error').flatMap((i) => i.roomIds ?? []));
  const warningRoomIds = new Set(issues.filter((i) => i.severity === 'warning').flatMap((i) => i.roomIds ?? []));
  // Optional-chained past `.reachability` too: defensive against an older/mid-flight generator build
  // that hasn't populated it yet (see reachability.ts's doc comment).
  const unreachableRoomIds = new Set((generatedMap?.reachability?.unreachableRooms ?? []).map((u) => u.roomId));

  // -------------------------------------------------------------- view: fit-to-container + zoom/pan
  const fitView = useCallback(() => {
    const el = containerRef.current;
    if (!el || !draft) return;
    const availW = Math.max(100, el.clientWidth - 48);
    const availH = Math.max(100, el.clientHeight - 48);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(availW / (draft.width * WORLD_TILE_PX), availH / (draft.height * WORLD_TILE_PX))));
    const worldMidX = (draft.width * WORLD_TILE_PX) / 2;
    const worldMidY = (draft.height * WORLD_TILE_PX) / 2;
    setView({ zoom, scrollX: worldMidX - el.clientWidth / 2 / zoom, scrollY: worldMidY - el.clientHeight / 2 / zoom });
  }, [draft]);

  // Refit when a different layout is loaded, or the grid is resized. Not on every room edit.
  const sessionKey = `${store.originalId ?? 'new'}:${draft?.width}x${draft?.height}`;
  useEffect(() => {
    fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fitView());
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitView]);

  const toScreen = useCallback((wx: number, wy: number) => ({ x: (wx - view.scrollX) * view.zoom, y: (wy - view.scrollY) * view.zoom }), [view]);
  const toWorldTile = useCallback(
    (screenX: number, screenY: number) => ({
      x: Math.floor(screenX / view.zoom / WORLD_TILE_PX + view.scrollX / WORLD_TILE_PX),
      y: Math.floor(screenY / view.zoom / WORLD_TILE_PX + view.scrollY / WORLD_TILE_PX),
    }),
    [view],
  );
  const screenPos = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  // ------------------------------------------------------------------------------- draw the canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const el = containerRef.current;
    if (!canvas || !el || !draft) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const T = WORLD_TILE_PX * view.zoom;
    const originX = -view.scrollX * view.zoom;
    const originY = -view.scrollY * view.zoom;

    // Grid background: the outer wall ring, tinted by `background`.
    ctx.fillStyle = draft.background === 'void' ? '#0e0b14' : '#1a1724';
    ctx.fillRect(originX, originY, draft.width * T, draft.height * T);

    // Tile grid lines (only when they'd be at least a few px apart, else it's just noise).
    if (T >= 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= draft.width; x++) {
        ctx.moveTo(originX + x * T + 0.5, originY);
        ctx.lineTo(originX + x * T + 0.5, originY + draft.height * T);
      }
      for (let y = 0; y <= draft.height; y++) {
        ctx.moveTo(originX, originY + y * T + 0.5);
        ctx.lineTo(originX + draft.width * T, originY + y * T + 0.5);
      }
      ctx.stroke();
    }

    // Generated overlay (debounced by the parent): corridors/doors/furniture/seats/stairs.
    if (generatedMap) {
      for (let y = 0; y < generatedMap.rows; y++) {
        for (let x = 0; x < generatedMap.cols; x++) {
          const tile = generatedMap.tiles[y]?.[x];
          if (tile === 'floor' && !generatedMap.roomAt[y]?.[x]) {
            ctx.fillStyle = 'rgba(255,255,255,0.05)';
            ctx.fillRect(originX + x * T, originY + y * T, T, T);
          } else if (tile === 'wall') {
            ctx.fillStyle = 'rgba(0,0,0,0.35)';
            ctx.fillRect(originX + x * T, originY + y * T, T, T);
          }
        }
      }
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      for (const f of generatedMap.furniture) ctx.fillRect(originX + f.x * T, originY + f.y * T, f.w * T, f.h * T);
      for (const seat of Object.values(generatedMap.zones).flatMap((z) => z.seats)) {
        ctx.fillStyle = seat.kind === 'sit' ? '#4ff0d0' : '#b07aff';
        ctx.beginPath();
        ctx.arc(originX + seat.x * T + T / 2, originY + seat.y * T + T / 2, Math.max(1.5, T * 0.12), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(8, T * 0.5)}px sans-serif`;
      for (const s of generatedMap.stairs) ctx.fillText(s.dir === 'up' ? '⬆' : '⬇', originX + s.x * T, originY + (s.y + 1) * T);
    }

    // Rooms: footprint fill (tinted by type), interior ring hint for walled rooms, name label,
    // and error/warning/selection/flash outlines.
    const now = performance.now();
    for (const room of draft.rooms) {
      const color = ROOM_COLORS[room.type] ?? '#888';
      const fx = originX + room.x * T;
      const fy = originY + room.y * T;
      const fw = room.w * T;
      const fh = room.h * T;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.32;
      ctx.fillRect(fx, fy, fw, fh);
      ctx.globalAlpha = 1;
      if (isRoomWalled(room)) {
        const inner = roomInterior(room);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(originX + inner.x * T, originY + inner.y * T, inner.w * T, inner.h * T);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(fx, fy, fw, fh);

      // Unreachable-room hatching (M8 8n): diagonal red stripes over the whole footprint, clipped to it.
      if (unreachableRoomIds.has(room.id)) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(fx, fy, fw, fh);
        ctx.clip();
        ctx.strokeStyle = 'rgba(239,68,68,0.55)';
        ctx.lineWidth = Math.max(1, T * 0.08);
        const step = Math.max(4, T * 0.5);
        for (let d = -fh; d < fw + fh; d += step) {
          ctx.beginPath();
          ctx.moveTo(fx + d, fy);
          ctx.lineTo(fx + d + fh, fy + fh);
          ctx.stroke();
        }
        ctx.restore();
      }

      const selected = selection.includes(room.id);
      const isError = errorRoomIds.has(room.id);
      const isWarning = warningRoomIds.has(room.id);
      const flashing = flashRoomIds.includes(room.id) && Math.floor(now / 200) % 2 === 0;
      if (flashing) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.strokeRect(fx - 1, fy - 1, fw + 2, fh + 2);
      } else if (isError) {
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2;
        ctx.strokeRect(fx - 1, fy - 1, fw + 2, fh + 2);
      } else if (isWarning) {
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 2;
        ctx.strokeRect(fx - 1, fy - 1, fw + 2, fh + 2);
      }
      if (selected) {
        ctx.strokeStyle = '#f5c07a';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 3]);
        ctx.strokeRect(fx - 2, fy - 2, fw + 4, fh + 4);
        ctx.setLineDash([]);
      }

      if (T >= 24) {
        ctx.fillStyle = '#e8e6f0';
        ctx.font = `${Math.max(9, Math.min(13, T * 0.28))}px sans-serif`;
        const label = room.name ?? theme.roomNames[room.type];
        ctx.fillText(label, fx + 4, fy + 14);
      }
    }

    // Doors (M8 8n): auto doors (from the generator) dashed, explicit doors solid; the selected one
    // (Doors tool) highlighted with end handles for resizing.
    for (const room of draft.rooms) {
      if (!isRoomWalled(room)) continue;
      const { doors, auto } = effectiveDoors(generatedMap, room);
      doors.forEach((door, index) => {
        const isSelected = tool === 'doors' && selectedDoor?.roomId === room.id && selectedDoor.index === index;
        ctx.strokeStyle = isSelected ? '#ffffff' : '#f5c07a';
        ctx.fillStyle = auto ? 'rgba(245,192,122,0.25)' : 'rgba(245,192,122,0.85)';
        ctx.lineWidth = isSelected ? 2.5 : 1.5;
        if (auto) ctx.setLineDash([3, 2]);
        for (const t of doorTiles(room, door)) {
          const dx = originX + t.x * T;
          const dy = originY + t.y * T;
          ctx.fillRect(dx, dy, T, T);
          ctx.strokeRect(dx + 1, dy + 1, T - 2, T - 2);
        }
        ctx.setLineDash([]);
        if (isSelected) {
          const { start, end } = doorEndpoints(room, door);
          ctx.fillStyle = '#ffffff';
          for (const p of [start, end]) {
            ctx.fillRect(originX + p.x * T + T / 2 - 3, originY + p.y * T + T / 2 - 3, 6, 6);
          }
        }
      });
    }

    // Resize handles for a single selection (not while the Doors tool has its own handles up).
    if (selection.length === 1 && tool !== 'doors') {
      const room = draft.rooms.find((r) => r.id === selection[0]);
      if (room) {
        const fx = originX + room.x * T;
        const fy = originY + room.y * T;
        const fw = room.w * T;
        const fh = room.h * T;
        const pts: Record<Handle, [number, number]> = {
          nw: [fx, fy],
          n: [fx + fw / 2, fy],
          ne: [fx + fw, fy],
          w: [fx, fy + fh / 2],
          e: [fx + fw, fy + fh / 2],
          sw: [fx, fy + fh],
          s: [fx + fw / 2, fy + fh],
          se: [fx + fw, fy + fh],
        };
        ctx.fillStyle = '#f5c07a';
        for (const h of HANDLES) {
          const [hx, hy] = pts[h];
          ctx.fillRect(hx - 3, hy - 3, 6, 6);
        }
      }
    }

    // In-progress draw rectangle.
    if (drawRect) {
      const color = ROOM_COLORS[pendingRoomType] ?? '#fff';
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(originX + drawRect.x * T, originY + drawRect.y * T, drawRect.w * T, drawRect.h * T);
      ctx.setLineDash([]);
      ctx.fillStyle = '#e8e6f0';
      ctx.font = '11px sans-serif';
      ctx.fillText(`${drawRect.w} x ${drawRect.h}`, originX + drawRect.x * T + 4, originY + drawRect.y * T - 4);
    }
  });

  // Esc cancels an in-progress draw (before the type picker even opens). Capture phase + a relevance
  // check means it only intercepts the event — and stops it reaching the editor's close handler —
  // when there's actually a draw to cancel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modeRef.current.kind === 'draw') {
        e.preventDefault();
        e.stopPropagation();
        modeRef.current = { kind: 'none' };
        setDrawRect(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Keep the flash animation ticking while any flashed room exists.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (flashRoomIds.length === 0) return;
    const id = setInterval(() => forceTick((n) => n + 1), 200);
    return () => clearInterval(id);
  }, [flashRoomIds]);

  if (!draft) return null;

  // -------------------------------------------------------------------------------- resize handles
  function hitHandle(screen: { x: number; y: number }): { roomId: string; handle: Handle; anchor: Rect } | null {
    if (selection.length !== 1) return null;
    const room = draft!.rooms.find((r) => r.id === selection[0]);
    if (!room) return null;
    const { x: fx, y: fy } = toScreen(room.x * WORLD_TILE_PX, room.y * WORLD_TILE_PX);
    const fw = room.w * WORLD_TILE_PX * view.zoom;
    const fh = room.h * WORLD_TILE_PX * view.zoom;
    const pts: Record<Handle, [number, number]> = {
      nw: [fx, fy],
      n: [fx + fw / 2, fy],
      ne: [fx + fw, fy],
      w: [fx, fy + fh / 2],
      e: [fx + fw, fy + fh / 2],
      sw: [fx, fy + fh],
      s: [fx + fw / 2, fy + fh],
      se: [fx + fw, fy + fh],
    };
    for (const h of HANDLES) {
      const [hx, hy] = pts[h];
      if (Math.hypot(screen.x - hx, screen.y - hy) <= HANDLE_HIT_PX) return { roomId: room.id, handle: h, anchor: room };
    }
    return null;
  }

  function hitRoom(tile: { x: number; y: number }): LayoutRoom | undefined {
    // Topmost (last-drawn) room whose footprint contains the tile wins.
    for (let i = draft!.rooms.length - 1; i >= 0; i--) {
      const r = draft!.rooms[i]!;
      if (tile.x >= r.x && tile.x < r.x + r.w && tile.y >= r.y && tile.y < r.y + r.h) return r;
    }
    return undefined;
  }

  function resizedRect(anchor: Rect, handle: Handle, tile: { x: number; y: number }): Rect {
    let { x, y, w, h } = anchor;
    const x2 = anchor.x + anchor.w;
    const y2 = anchor.y + anchor.h;
    if (handle.includes('w')) {
      x = Math.min(tile.x, x2 - 1);
      w = x2 - x;
    }
    if (handle.includes('e')) {
      w = Math.max(1, tile.x + 1 - x);
    }
    if (handle.includes('n')) {
      y = Math.min(tile.y, y2 - 1);
      h = y2 - y;
    }
    if (handle.includes('s')) {
      h = Math.max(1, tile.y + 1 - y);
    }
    return { x: Math.max(0, x), y: Math.max(0, y), w, h };
  }

  // ----------------------------------------------------------------------------------- door handles
  /** The selected door's start/end resize handles, in screen space. */
  function hitDoorHandle(screen: { x: number; y: number }): { roomId: string; index: number; handle: DoorHandle; anchor: DoorSpec } | null {
    if (tool !== 'doors' || !selectedDoor) return null;
    const room = draft!.rooms.find((r) => r.id === selectedDoor.roomId);
    if (!room) return null;
    const door = effectiveDoors(generatedMap, room).doors[selectedDoor.index];
    if (!door) return null;
    const { start, end } = doorEndpoints(room, door);
    for (const [handle, tilePos] of [
      ['start', start],
      ['end', end],
    ] as [DoorHandle, { x: number; y: number }][]) {
      const s = toScreen((tilePos.x + 0.5) * WORLD_TILE_PX, (tilePos.y + 0.5) * WORLD_TILE_PX);
      if (Math.hypot(screen.x - s.x, screen.y - s.y) <= HANDLE_HIT_PX) return { roomId: room.id, index: selectedDoor.index, handle, anchor: door };
    }
    return null;
  }

  /** How many tiles a door's `n`/`s` (x-axis) or `e`/`w` (y-axis) wall run has. */
  const wallLength = (room: LayoutRoom, side: DoorSide) => (side === 'n' || side === 's' ? room.w : room.h);

  /** Clamps a door rect so it stays strictly between the room's corners (matches `door-invalid`). */
  function clampDoorRect(room: LayoutRoom, side: DoorSide, offset: number, width: number): { offset: number; width: number } {
    const len = wallLength(room, side);
    const w = Math.max(1, Math.min(3, width));
    const o = Math.max(1, Math.min(len - 1 - w, offset));
    return { offset: o, width: w };
  }

  const onPointerDown: PointerEventHandler<HTMLCanvasElement> = (e) => {
    if (builtin) return; // read-only until "Duplicate to edit"
    canvasRef.current?.setPointerCapture(e.pointerId);
    const screen = screenPos(e);
    downRef.current = { screen, moved: false };
    const tile = toWorldTile(screen.x, screen.y);

    if (tool === 'hand' || e.button === 1) {
      modeRef.current = { kind: 'pan', startScreen: screen, startScroll: { x: view.scrollX, y: view.scrollY } };
      return;
    }
    if (tool === 'room' || tool === 'stairs') {
      modeRef.current = { kind: 'draw', startTile: tile };
      setDrawRect({ x: tile.x, y: tile.y, w: 1, h: 1 });
      return;
    }
    if (tool === 'doors') {
      const doorHandleHit = hitDoorHandle(screen);
      if (doorHandleHit) {
        modeRef.current = { kind: 'resize-door', ...doorHandleHit };
        store.beginGesture();
        return;
      }
      const doorHit = hitDoorAt(draft.rooms, generatedMap, tile);
      if (doorHit) {
        // First edit on an auto-door room materializes it (so nothing jumps) before the drag starts.
        store.ensureExplicitDoors(doorHit.room.id, doorHit.doors);
        store.selectDoor(doorHit.room.id, doorHit.index);
        modeRef.current = { kind: 'move-door', roomId: doorHit.room.id, index: doorHit.index };
        store.beginGesture();
        return;
      }
      const wall = wallHit(draft.rooms, tile);
      if (wall) {
        const { room, side, offset } = wall;
        const len = wallLength(room, side);
        const current = effectiveDoors(generatedMap, room).doors;
        const width = e.shiftKey && offset + 2 <= len - 1 ? 2 : 1;
        store.addDoor(room.id, { side, offset, width }, current);
        store.selectDoor(room.id, current.length);
        modeRef.current = { kind: 'none' };
        return;
      }
      store.clearDoorSelection();
      modeRef.current = { kind: 'none' };
      return;
    }
    // Select tool.
    const handleHit = hitHandle(screen);
    if (handleHit) {
      modeRef.current = { kind: 'resize', roomId: handleHit.roomId, handle: handleHit.handle, anchor: handleHit.anchor };
      store.beginGesture();
      return;
    }
    const room = hitRoom(tile);
    if (room) {
      if (!selection.includes(room.id)) store.select([room.id], e.shiftKey);
      modeRef.current = { kind: 'move', lastTile: tile, moved: false };
      store.beginGesture();
      return;
    }
    modeRef.current = { kind: 'none' };
  };

  const onPointerMove: PointerEventHandler<HTMLCanvasElement> = (e) => {
    const screen = screenPos(e);
    if (downRef.current && !downRef.current.moved) {
      downRef.current.moved = isDragMove(screen.x - downRef.current.screen.x, screen.y - downRef.current.screen.y);
    }
    const mode = modeRef.current;
    if (mode.kind === 'pan') {
      const dx = (screen.x - mode.startScreen.x) / view.zoom;
      const dy = (screen.y - mode.startScreen.y) / view.zoom;
      setView((v) => ({ ...v, scrollX: mode.startScroll.x - dx, scrollY: mode.startScroll.y - dy }));
      return;
    }
    if (mode.kind === 'draw') {
      const tile = toWorldTile(screen.x, screen.y);
      const clampedX = Math.max(0, Math.min(draft.width - 1, tile.x));
      const clampedY = Math.max(0, Math.min(draft.height - 1, tile.y));
      const x0 = Math.min(mode.startTile.x, clampedX);
      const y0 = Math.min(mode.startTile.y, clampedY);
      const x1 = Math.max(mode.startTile.x, clampedX);
      const y1 = Math.max(mode.startTile.y, clampedY);
      setDrawRect({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
      return;
    }
    if (mode.kind === 'move') {
      const tile = toWorldTile(screen.x, screen.y);
      const dx = tile.x - mode.lastTile.x;
      const dy = tile.y - mode.lastTile.y;
      if (dx !== 0 || dy !== 0) {
        store.moveRoomsBy(selection, dx, dy);
        modeRef.current = { ...mode, lastTile: tile, moved: true };
      }
      return;
    }
    if (mode.kind === 'resize') {
      const tile = toWorldTile(screen.x, screen.y);
      store.resizeRoomTo(mode.roomId, resizedRect(mode.anchor, mode.handle, tile));
      return;
    }
    if (mode.kind === 'move-door') {
      const room = draft.rooms.find((r) => r.id === mode.roomId);
      const door = room?.doors?.[mode.index];
      if (!room || !door) return;
      const tile = toWorldTile(screen.x, screen.y);
      const raw = door.side === 'n' || door.side === 's' ? tile.x - room.x : tile.y - room.y;
      const { offset } = clampDoorRect(room, door.side, raw, door.width ?? 1);
      if (offset !== door.offset) store.setDoorRect(room.id, mode.index, { offset });
      return;
    }
    if (mode.kind === 'resize-door') {
      const room = draft.rooms.find((r) => r.id === mode.roomId);
      if (!room) return;
      const tile = toWorldTile(screen.x, screen.y);
      const raw = mode.anchor.side === 'n' || mode.anchor.side === 's' ? tile.x - room.x : tile.y - room.y;
      const anchorWidth = mode.anchor.width ?? 1;
      let rect: { offset: number; width: number };
      if (mode.handle === 'end') {
        rect = clampDoorRect(room, mode.anchor.side, mode.anchor.offset, raw - mode.anchor.offset + 1);
      } else {
        const fixedEnd = mode.anchor.offset + anchorWidth - 1;
        const width = Math.max(1, Math.min(3, fixedEnd - raw + 1));
        rect = clampDoorRect(room, mode.anchor.side, fixedEnd - width + 1, width);
      }
      store.setDoorRect(room.id, mode.index, rect);
      return;
    }
  };

  const onPointerUp: PointerEventHandler<HTMLCanvasElement> = (e) => {
    const mode = modeRef.current;
    const wasDrag = downRef.current?.moved ?? false;
    downRef.current = null;
    modeRef.current = { kind: 'none' };

    if (mode.kind === 'draw') {
      const rect = drawRect;
      setDrawRect(null);
      if (rect && rect.w >= 1 && rect.h >= 1) {
        if (tool === 'stairs') {
          store.addRoom({ id: genRoomId(), type: 'stairs', ...rect });
        } else {
          setPendingPick({ rect, screen: screenPos(e) });
        }
      }
      return;
    }
    if (mode.kind === 'move' || mode.kind === 'resize' || mode.kind === 'move-door' || mode.kind === 'resize-door') {
      store.endGesture();
      return;
    }
    if (mode.kind === 'none' && !wasDrag && tool === 'select') {
      store.clearSelection();
    }
  };

  const onWheel: WheelEventHandler<HTMLCanvasElement> = (e) => {
    e.preventDefault();
    const screen = screenPos(e);
    const factor = Math.exp(-e.deltaY * 0.001);
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
    const { scrollX, scrollY } = zoomAboutPoint({ pointerX: screen.x, pointerY: screen.y, scrollX: view.scrollX, scrollY: view.scrollY, oldZoom: view.zoom, newZoom });
    setView({ zoom: newZoom, scrollX, scrollY });
  };

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-ink-950">
      <canvas
        ref={canvasRef}
        className={
          tool === 'hand'
            ? 'cursor-grab active:cursor-grabbing'
            : tool === 'room' || tool === 'stairs' || tool === 'doors'
              ? 'cursor-crosshair'
              : 'cursor-default'
        }
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
      />
      {pendingPick && (
        <RoomTypePicker
          theme={theme}
          x={pendingPick.screen.x}
          y={pendingPick.screen.y}
          onPick={(type) => {
            const room: LayoutRoom = { id: genRoomId(), type, ...pendingPick.rect };
            store.addRoom(room);
            store.select([room.id]);
            store.setPendingRoomType(type);
            setPendingPick(null);
          }}
          onCancel={() => setPendingPick(null)}
        />
      )}
      {builtin && (
        <div className="pointer-events-none absolute inset-x-0 top-0 bg-amber-900/80 px-3 py-1 text-center text-[11px] text-amber-100">
          Read-only builtin layout — "Duplicate to edit" to make changes.
        </div>
      )}
    </div>
  );
}
