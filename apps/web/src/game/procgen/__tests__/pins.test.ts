import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, hasLayoutErrors, roomInterior, type LayoutRoom, type OfficeLayout, type PinnedFurniture } from '@tagconn/shared';
import { generateRandomLayout } from '../bsp';
import { generateMap } from '../generate';
import { isPinnableKind, KIND_BLOCKING, resolvePins } from '../pins';
import { seatsFor } from '../recipes';
import { mulberry32 } from '../rng';
import type { GeneratedMap, PlacedFurniture } from '../types';

const errors = (map: GeneratedMap) => map.issues.filter((i) => i.severity === 'error');

/** What the editor does: a generated item becomes a pin relative to its room's interior. */
function pinFromPlaced(f: PlacedFurniture, interior: { x: number; y: number }): PinnedFurniture {
  return { kind: f.kind, x: f.x - interior.x, y: f.y - interior.y, w: f.w, h: f.h, variant: f.variant };
}

const overlaps = (a: PinnedFurniture, b: PinnedFurniture) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Pins 1-3 random non-overlapping pinnable items per room of the layout's own generated map. */
function pinRandomly(layout: OfficeLayout, rand: () => number): OfficeLayout {
  const map = generateMap(layout);
  const rooms: LayoutRoom[] = layout.rooms.map((r) => {
    const interior = roomInterior(r);
    const pool = map.furniture.filter((f) => f.roomId === r.id && isPinnableKind(f.kind) && !f.pinned);
    const want = 1 + Math.floor(rand() * 3);
    const picked: PinnedFurniture[] = [];
    for (let i = 0; i < want && pool.length; i++) {
      const f = pool.splice(Math.floor(rand() * pool.length), 1)[0]!;
      const pin = pinFromPlaced(f, interior);
      if (picked.some((p) => overlaps(p, pin))) continue;
      picked.push(pin);
    }
    return picked.length ? { ...r, furniture: picked } : r;
  });
  return { ...layout, rooms };
}

function expectPinsInPlace(layout: OfficeLayout, map: GeneratedMap, label: string): void {
  for (const r of layout.rooms) {
    const interior = roomInterior(r);
    for (const p of r.furniture ?? []) {
      const hit = map.furniture.find(
        (f) => f.roomId === r.id && f.kind === p.kind && f.x === interior.x + p.x && f.y === interior.y + p.y && f.w === p.w && f.h === p.h,
      );
      expect(hit, `${label}: ${r.id} ${p.kind}`).toBeDefined();
      expect(hit!.pinned, `${label}: ${r.id} ${p.kind} pinned`).toBe(true);
      expect(hit!.variant).toBe(p.variant ?? 0);
    }
  }
}

function sweep(layout: OfficeLayout, label: string, rand: () => number): void {
  const baseErrors = errors(generateMap(layout)).length;
  const pinned = pinRandomly(layout, rand);
  const map = generateMap(pinned);
  expectPinsInPlace(pinned, map, label);
  // Never a silent fallback to DEFAULT_LAYOUT for a pinned layout that validates.
  expect(map.layoutId, label).toBe(layout.id);
  const newErrors = errors(map).length > baseErrors;
  if (newErrors) expect(map.issues.some((i) => i.code === 'pinned-blocks'), `${label}: new errors need pinned-blocks`).toBe(true);
  // Reroll a room's furnish seed: every pin stays put.
  const rerolled: OfficeLayout = { ...pinned, rooms: pinned.rooms.map((r) => ({ ...r, furnish: { ...r.furnish, seed: 77 } })) };
  expectPinsInPlace(rerolled, generateMap(rerolled), `${label} reroll`);
}

function asLayout(input: ReturnType<typeof generateRandomLayout>, seed: number): OfficeLayout {
  return { ...input, background: input.background ?? 'hall', corridorWidth: input.corridorWidth ?? 2, id: `bsp${seed}`, builtin: false, createdAt: 0, updatedAt: 0 };
}

describe('pins: generation', () => {
  it('DEFAULT_LAYOUT keeps 1-3 pins per room in place, and a reroll keeps them', () => {
    for (let s = 1; s <= 5; s++) sweep(DEFAULT_LAYOUT, `default #${s}`, mulberry32(s));
  });

  it('100 random BSP layouts', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const layout = asLayout(generateRandomLayout({ width: 48, height: 30, seed, background: seed % 2 ? 'hall' : 'void' }), seed);
      sweep(layout, `bsp ${seed}`, mulberry32(seed * 7919));
    }
  }, 60000);

  it('a layout without pins is unchanged by the pin code (same furniture, nothing pinned)', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    expect(map.furniture.some((f) => f.pinned)).toBe(false);
    expect(generateMap(DEFAULT_LAYOUT)).toEqual(map);
  });

  it('skips unknown kinds, items outside the interior and overlaps with a warning, never throws or falls back', () => {
    const desks = DEFAULT_LAYOUT.rooms.find((r) => r.type === 'desks')!;
    const bad: PinnedFurniture[] = [
      { kind: 'unicorn', x: 1, y: 1, w: 1, h: 1 },
      { kind: 'plant', x: 999, y: 0, w: 1, h: 1 },
      { kind: 'stairs-up', x: 0, y: 0, w: 1, h: 1 },
      { kind: 'plant', x: 2, y: 2, w: 1, h: 1 },
      { kind: 'crate', x: 2, y: 2, w: 1, h: 1 },
    ];
    const layout: OfficeLayout = { ...DEFAULT_LAYOUT, rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === desks.id ? { ...r, furniture: bad } : r)) };
    const map = generateMap(layout);
    // validateLayout already rejects the geometry-invalid ones (error -> fallback), so drop those for this
    // assertion and exercise resolvePins directly for the rest.
    const res = resolvePins({ ...desks, furniture: bad }, roomInterior(desks), new Set());
    expect(res.items.map((i) => i.kind)).toEqual(['plant']);
    expect(res.issues.filter((i) => i.code === 'pinned-invalid')).toHaveLength(4);
    expect(res.issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(map.cols).toBeGreaterThan(0);
  });

  it('a pinned unknown kind alone is skipped with a warning (no fallback)', () => {
    const desks = DEFAULT_LAYOUT.rooms.find((r) => r.type === 'desks')!;
    const layout: OfficeLayout = {
      ...DEFAULT_LAYOUT,
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === desks.id ? { ...r, furniture: [{ kind: 'unicorn', x: 1, y: 1, w: 1, h: 1 }] } : r)),
    };
    const map = generateMap(layout);
    expect(map.layoutId).toBe(layout.id);
    expect(map.issues.some((i) => i.code === 'pinned-invalid' && i.severity === 'warning')).toBe(true);
    expect(hasLayoutErrors(map.issues)).toBe(false);
  });

  it('pinned furniture brings its seats and is never removed by the retry', () => {
    const desks = DEFAULT_LAYOUT.rooms.find((r) => r.type === 'desks')!;
    const layout: OfficeLayout = {
      ...DEFAULT_LAYOUT,
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === desks.id ? { ...r, furniture: [{ kind: 'work-desk', x: 0, y: 0, w: 2, h: 1 }] } : r)),
    };
    const map = generateMap(layout);
    const interior = roomInterior(desks);
    const pin = map.furniture.find((f) => f.pinned && f.roomId === desks.id)!;
    expect(pin).toMatchObject({ kind: 'work-desk', x: interior.x, y: interior.y, blocking: true });
    expect(map.furniture.filter((f) => f.roomId === desks.id && f.blocking && f !== pin && f.x < pin.x + 2 && f.x + f.w > pin.x && f.y === pin.y)).toEqual([]);
  });

  it('ignores pins in a stairs room (with a warning) and places them in a hall without blocking', () => {
    const stairs = DEFAULT_LAYOUT.rooms.find((r) => r.type === 'stairs')!;
    const layout: OfficeLayout = {
      ...DEFAULT_LAYOUT,
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === stairs.id ? { ...r, furniture: [{ kind: 'plant', x: 0, y: 0, w: 1, h: 1 }] } : r)),
    };
    const map = generateMap(layout);
    expect(map.furniture.some((f) => f.pinned)).toBe(false);
    expect(map.issues.some((i) => i.code === 'pinned-invalid' && i.roomIds?.includes(stairs.id))).toBe(true);

    const hall: LayoutRoom = { id: 'h', type: 'hall', x: 12, y: 1, w: 8, h: 6, furniture: [{ kind: 'table', x: 1, y: 1, w: 2, h: 1 }] };
    const entrance: LayoutRoom = { id: 'e', type: 'entrance', x: 1, y: 12, w: 8, h: 6 };
    const hallLayout: OfficeLayout = {
      id: 'hall-pin', name: 'hall-pin', width: 30, height: 20, seed: 3, background: 'hall', corridorWidth: 2,
      builtin: false, createdAt: 0, updatedAt: 0, rooms: [entrance, hall, { id: 's', type: 'stairs', x: 12, y: 12, w: 4, h: 4 }],
    };
    const hm = generateMap(hallLayout);
    expect(hm.layoutId).toBe('hall-pin');
    const f = hm.furniture.find((x) => x.roomId === 'h' && x.pinned);
    expect(f).toMatchObject({ kind: 'table', blocking: false });
  });
});

describe('pins: helpers', () => {
  it('KIND_BLOCKING covers a few known kinds', () => {
    expect(KIND_BLOCKING['work-desk']).toBe(true);
    expect(KIND_BLOCKING.rug).toBe(false);
    expect(isPinnableKind('stairs-up')).toBe(false);
    expect(isPinnableKind('plant')).toBe(true);
    expect(isPinnableKind('__proto__')).toBe(false);
  });

  it('seatsFor puts a desk row on the outward side and falls back above at the bottom edge', () => {
    const interior = { x: 0, y: 0, w: 6, h: 4 };
    expect(seatsFor('work-desk', { x: 1, y: 1, w: 2, h: 1 }, interior)).toEqual([
      { x: 1, y: 2, kind: 'sit' },
      { x: 2, y: 2, kind: 'sit' },
    ]);
    expect(seatsFor('work-desk', { x: 1, y: 3, w: 2, h: 1 }, interior).map((s) => s.y)).toEqual([2, 2]);
    expect(seatsFor('plant', { x: 1, y: 1, w: 1, h: 1 }, interior)).toEqual([]);
    expect(seatsFor('console', { x: 3, y: 1, w: 1, h: 1 }, interior)).toEqual([{ x: 2, y: 1, kind: 'sit' }]);
    expect(seatsFor('table', { x: 1, y: 1, w: 2, h: 1 }, interior)).toHaveLength(6);
  });

  it('resolvePins skips a blocking pin on a door apron with pinned-blocks, and keeps a soft one', () => {
    const room = { id: 'r', type: 'desks' as const, name: undefined, furniture: [{ kind: 'work-desk', x: 0, y: 0, w: 2, h: 1 }] };
    const res = resolvePins(room, { x: 5, y: 5, w: 6, h: 4 }, new Set(['6,5']));
    expect(res.items).toHaveLength(0);
    expect(res.issues.map((i) => i.code)).toEqual(['pinned-blocks']);
    const rug = { ...room, furniture: [{ kind: 'rug', x: 0, y: 0, w: 2, h: 1 }] };
    expect(resolvePins(rug, { x: 5, y: 5, w: 6, h: 4 }, new Set(['6,5'])).items).toHaveLength(1);
  });

  it('a pin over an AUTOMATIC door apron is skipped with a warning and never seals the room', () => {
    const base = generateMap(DEFAULT_LAYOUT);
    const door = base.doors.find((d) => d.roomId !== 'stairs' && DEFAULT_LAYOUT.rooms.some((r) => r.id === d.roomId && r.type !== 'stairs'))!;
    const desks = DEFAULT_LAYOUT.rooms.find((r) => r.id === door.roomId)!;
    const interior = roomInterior(desks);
    const inside = (x: number, y: number) => x >= interior.x && x < interior.x + interior.w && y >= interior.y && y < interior.y + interior.h;
    const apron = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: door.x + dx!, y: door.y + dy! })).find((p) => inside(p.x, p.y))!;
    const layout: OfficeLayout = {
      ...DEFAULT_LAYOUT,
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === desks.id ? { ...r, furniture: [{ kind: 'table', x: apron.x - interior.x, y: apron.y - interior.y, w: 1, h: 1 }] } : r)),
    };
    const map = generateMap(layout);
    expect(map.layoutId).toBe(layout.id);
    expect(map.furniture.some((f) => f.pinned && f.roomId === desks.id)).toBe(false);
    expect(map.issues.filter((i) => i.code === 'pinned-blocks' && i.roomIds?.includes(desks.id))).toHaveLength(1);
    expect(map.reachability.unreachableRooms).toEqual([]);
  });

  it('a pin that displaces a recipe item takes the item\'s recipe seats with it', () => {
    const desks = DEFAULT_LAYOUT.rooms.find((r) => r.type === 'desks')!;
    const interior = roomInterior(desks);
    const base = generateMap(DEFAULT_LAYOUT);
    const desk = base.furniture.find((f) => f.roomId === desks.id && f.kind === 'work-desk' && !f.pinned)!;
    const rug: PinnedFurniture = { kind: 'rug', x: desk.x - interior.x, y: desk.y - interior.y, w: desk.w, h: desk.h };
    const layout: OfficeLayout = { ...DEFAULT_LAYOUT, rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === desks.id ? { ...r, furniture: [rug] } : r)) };
    const map = generateMap(layout);
    expect(map.furniture.some((f) => f.roomId === desks.id && f.kind === 'work-desk' && f.x === desk.x && f.y === desk.y)).toBe(false);
    // The recipe seats the desk's row from above (y - 1): with the desk gone, nobody sits there.
    const seats = map.rooms.find((r) => r.id === desks.id)!.seats;
    const orphans = seats.filter((st) => st.x >= desk.x && st.x < desk.x + desk.w && Math.abs(st.y - desk.y) === 1 && st.y < desk.y);
    expect(orphans).toEqual([]);
    // ...while the unpinned layout does seat it.
    const baseSeats = base.rooms.find((r) => r.id === desks.id)!.seats;
    expect(baseSeats.some((st) => st.x === desk.x && st.y === desk.y - 1)).toBe(true);
  });

  it('reports each bad pin kind once per room (validateLayout and resolvePins no longer both report it)', () => {
    const desks = DEFAULT_LAYOUT.rooms.find((r) => r.type === 'desks')!;
    const bad: PinnedFurniture[] = [
      { kind: 'plant', x: 2, y: 2, w: 1, h: 1 },
      { kind: 'crate', x: 2, y: 2, w: 1, h: 1 },
      { kind: 'lamp', x: 2, y: 2, w: 1, h: 1 },
      { kind: 'unicorn', x: 4, y: 4, w: 1, h: 1 },
    ];
    const layout: OfficeLayout = { ...DEFAULT_LAYOUT, rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === desks.id ? { ...r, furniture: bad } : r)) };
    const mine = generateMap(layout).issues.filter((i) => i.code.startsWith('pinned-') && i.roomIds?.includes(desks.id));
    expect(mine.map((i) => i.code)).toEqual(['pinned-invalid']);
  });
});
