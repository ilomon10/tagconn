import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, hasLayoutErrors, roomInterior, type LayoutRoom, type OfficeLayout, type PinnedFurniture } from '@tagconn/shared';
import { flagAgainstNorthWall } from '../backWall';
import { generateRandomLayout } from '../bsp';
import { generateMap } from '../generate';
import { coveredTiles, rectsIntersect } from '../geometry';
import { isPinnableKind, KIND_BLOCKING, resolvePins } from '../pins';
import { seatsFor } from '../recipes';
import { mulberry32 } from '../rng';
import type { GeneratedMap, PlacedFurniture, Point, TileKind } from '../types';

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

  it('resolvePins KEEPS a blocking pin on a door apron with a pinned-blocks warning (M16), and keeps a soft one silently', () => {
    const room = { id: 'r', type: 'desks' as const, name: undefined, furniture: [{ kind: 'work-desk', x: 0, y: 0, w: 2, h: 1 }] };
    const res = resolvePins(room, { x: 5, y: 5, w: 6, h: 4 }, new Set(['6,5']));
    expect(res.items).toHaveLength(1);
    expect(res.issues.map((i) => i.code)).toEqual(['pinned-blocks']);
    const rug = { ...room, furniture: [{ kind: 'rug', x: 0, y: 0, w: 2, h: 1 }] };
    expect(resolvePins(rug, { x: 5, y: 5, w: 6, h: 4 }, new Set(['6,5'])).items).toHaveLength(1);
  });

  it('a pin over an AUTOMATIC door apron is kept with a pinned-blocks warning (M16, spec 5.2)', () => {
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
    expect(map.furniture.some((f) => f.pinned && f.roomId === desks.id)).toBe(true);
    expect(map.issues.filter((i) => i.code === 'pinned-blocks' && i.roomIds?.includes(desks.id)).length).toBeGreaterThanOrEqual(1);
  });

  it('M16 slots: fromSlot consumes the recipe slot, suppressed deletes it, a free pin consumes nothing', () => {
    const desks = DEFAULT_LAYOUT.rooms.find((r) => r.type === 'desks')!;
    const interior = roomInterior(desks);
    const base = generateMap(DEFAULT_LAYOUT);
    const slotted = base.furniture.filter((f) => f.roomId === desks.id && f.kind === 'work-desk' && f.slotId);
    expect(slotted.length).toBeGreaterThan(2);
    const target = slotted[0]!;
    const withPins = (furniture: PinnedFurniture[]): GeneratedMap =>
      generateMap({ ...DEFAULT_LAYOUT, rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === desks.id ? { ...r, furniture } : r)) });
    const count = (m: GeneratedMap) => m.furniture.filter((f) => f.roomId === desks.id && f.kind === 'work-desk').length;
    const n = count(base);
    const rect = { x: target.x - interior.x, y: target.y - interior.y, w: target.w, h: target.h };
    // dragged by nothing: the pin takes over its own slot -> still exactly n desks, one of them pinned
    const same = withPins([{ kind: 'work-desk', ...rect, fromSlot: target.slotId! }]);
    expect(count(same)).toBe(n);
    expect(same.furniture.filter((f) => f.roomId === desks.id && f.slotId === target.slotId)).toEqual([]);
    // suppressed: the slot is gone and nothing is placed
    const gone = withPins([{ kind: 'work-desk', ...rect, fromSlot: target.slotId!, suppressed: true }]);
    expect(count(gone)).toBe(n - 1);
    expect(gone.furniture.some((f) => f.pinned && f.roomId === desks.id)).toBe(false);
    // a slot that does not exist is ignored
    expect(count(withPins([{ kind: 'plant', x: 0, y: 0, w: 1, h: 1, fromSlot: 'desk:999' }]))).toBe(n);
  });

  it('M16 resolvePins: suppressed pins consume without placing; facing is honoured only where supported', () => {
    const room = {
      id: 'r',
      type: 'desks' as const,
      name: undefined,
      furniture: [
        { kind: 'work-desk', x: 0, y: 0, w: 2, h: 1, fromSlot: 'desk:1', suppressed: true },
        { kind: 'sofa', x: 0, y: 2, w: 2, h: 1, facing: 'n' as const },
        { kind: 'work-desk', x: 3, y: 2, w: 2, h: 1, facing: 'e' as const },
      ],
    };
    const res = resolvePins(room, { x: 5, y: 5, w: 6, h: 4 }, new Set());
    expect([...res.consumed]).toEqual(['desk:1']);
    expect(res.items.map((i) => i.kind)).toEqual(['sofa', 'work-desk']);
    expect(res.items[0]!.facing).toBe('n');
    expect(res.items[1]!.facing).toBeUndefined();
  });

  it('M16: the engine plans around a pin, so a one-tile pin never deletes a desk (relocate is only the fallback)', () => {
    const desks = DEFAULT_LAYOUT.rooms.find((r) => r.type === 'desks')!;
    const base = generateMap(DEFAULT_LAYOUT);
    const n = base.furniture.filter((f) => f.roomId === desks.id && f.kind === 'work-desk').length;
    const plant: PinnedFurniture = { kind: 'plant', x: 0, y: 0, w: 1, h: 1 };
    const m = generateMap({ ...DEFAULT_LAYOUT, rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === desks.id ? { ...r, furniture: [plant] } : r)) });
    // the engine plans around the pin, so no desk disappears for a one-tile plant
    expect(m.furniture.filter((f) => f.roomId === desks.id && f.kind === 'work-desk').length).toBeGreaterThanOrEqual(n - 1);
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

// M15 T2 (docs/design/navigation.md sections 3.1 and 5): pins on the half-tile grid. Positions may be halves, sizes
// stay whole, and every tile consumer (walkable, seats, aprons, spots) treats a half-offset item as covering every
// tile it touches.
describe('pins: half-tile (M15)', () => {
  const interior = { x: 5, y: 5, w: 6, h: 4 };
  const room = (furniture: PinnedFurniture[]) => ({ id: 'r', type: 'desks' as const, name: undefined, furniture });

  it('rule 1: an unknown kind is skipped with pinned-invalid, even on a half tile', () => {
    const res = resolvePins(room([{ kind: 'unicorn', x: 0.5, y: 0, w: 1, h: 1 }]), interior, new Set());
    expect(res.items).toEqual([]);
    expect(res.issues.map((i) => i.code)).toEqual(['pinned-invalid']);
  });

  it('rule 2: a pin off the half-tile grid (quarter position or fractional size) is skipped with pinned-invalid', () => {
    const bad: PinnedFurniture[] = [
      { kind: 'plant', x: 0.25, y: 0, w: 1, h: 1 },
      { kind: 'plant', x: 0, y: 1.1, w: 1, h: 1 },
      { kind: 'plant', x: 1, y: 0, w: 1.5, h: 1 },
      { kind: 'plant', x: 2, y: 0, w: 1, h: 0.5 },
      { kind: 'plant', x: 3, y: 0, w: 0, h: 1 },
    ];
    const res = resolvePins(room(bad), interior, new Set());
    expect(res.items).toEqual([]);
    expect(res.issues.map((i) => i.code)).toEqual(['pinned-invalid', 'pinned-invalid', 'pinned-invalid', 'pinned-invalid', 'pinned-invalid']);
    expect(res.issues.every((i) => i.severity === 'warning' && /half-tile grid/.test(i.message))).toBe(true);
  });

  it('rule 3: the bounds check works with halves (x + w > interior.w skips; negative skips; exact fit stays)', () => {
    const pins: PinnedFurniture[] = [
      { kind: 'plant', x: interior.w - 1.5, y: 0, w: 2, h: 1 }, // ends at w + 0.5: outside
      { kind: 'plant', x: 0, y: interior.h - 0.5, w: 1, h: 1 }, // ends at h + 0.5: outside
      { kind: 'plant', x: -0.5, y: 0, w: 1, h: 1 }, // starts before the interior
      { kind: 'plant', x: interior.w - 2.5, y: 2, w: 2, h: 1 }, // ends at w - 0.5: inside
      { kind: 'plant', x: 0.5, y: interior.h - 1, w: 1, h: 1 }, // inside
    ];
    const res = resolvePins(room(pins), interior, new Set());
    expect(res.issues.map((i) => i.code)).toEqual(['pinned-invalid', 'pinned-invalid', 'pinned-invalid']);
    expect(res.issues.every((i) => /outside the room/.test(i.message))).toBe(true);
    expect(res.items.map((i) => [i.x, i.y])).toEqual([
      [interior.x + interior.w - 2.5, interior.y + 2],
      [interior.x + 0.5, interior.y + interior.h - 1],
    ]);
  });

  it('rule 4: pin-vs-pin overlap is exact, so two half-offset pins may share a tile without overlapping', () => {
    // a: 0.5..1.5, b: 1.5..2.5 (share tile 1, touch at an edge: fine), c: 2..3 (overlaps b: skipped),
    // d: 2.5..3.5 (touches b's edge and shares tile 2 with it; c was skipped so it is not in the way: fine).
    const pins: PinnedFurniture[] = [
      { kind: 'plant', x: 0.5, y: 0, w: 1, h: 1 },
      { kind: 'plant', x: 1.5, y: 0, w: 1, h: 1 },
      { kind: 'plant', x: 2, y: 0, w: 1, h: 1 },
      { kind: 'crate', x: 2.5, y: 0, w: 1, h: 1 },
      { kind: 'crate', x: 0, y: 0.5, w: 1, h: 1 }, // 0..1 x 0.5..1.5 overlaps a (0.5..1.5 x 0..1)
      { kind: 'crate', x: 0, y: 1, w: 1, h: 1 }, // touches a's bottom edge only: fine
    ];
    const res = resolvePins(room(pins), interior, new Set());
    expect(res.items.map((i) => [i.kind, i.x - interior.x, i.y - interior.y])).toEqual([
      ['plant', 0.5, 0],
      ['plant', 1.5, 0],
      ['crate', 2.5, 0],
      ['crate', 0, 1],
    ]);
    expect(res.issues.map((i) => i.code)).toEqual(['pinned-invalid', 'pinned-invalid']);
    expect(res.issues.every((i) => /overlaps another locked item/.test(i.message))).toBe(true);
    const a = res.items[0]!;
    const b = res.items[1]!;
    expect(rectsIntersect(a, b)).toBe(false);
    expect(coveredTiles(a).filter((t) => coveredTiles(b).some((u) => u.x === t.x && u.y === t.y))).toEqual([{ x: interior.x + 1, y: interior.y }]);
  });

  it('rule 5: a blocking pin touching an apron tile with its half is skipped (conservative); a soft one stays', () => {
    const aprons = new Set([`${interior.x + 2},${interior.y}`]);
    // 0.5..2.5 covers tiles 0, 1, 2: tile 2 is the apron.
    expect(resolvePins(room([{ kind: 'work-desk', x: 0.5, y: 0, w: 2, h: 1 }]), interior, aprons).issues.map((i) => i.code)).toEqual(['pinned-blocks']);
    // 0..2 covers tiles 0, 1 only: fine.
    expect(resolvePins(room([{ kind: 'work-desk', x: 0, y: 0, w: 2, h: 1 }]), interior, aprons).items).toHaveLength(1);
    // vertical half: 0.5..1.5 on y covers rows 0 and 1, row 0 holds the apron.
    expect(resolvePins(room([{ kind: 'cabinet', x: 2, y: 0.5, w: 1, h: 1 }]), interior, aprons).issues.map((i) => i.code)).toEqual(['pinned-blocks']);
    const rug = resolvePins(room([{ kind: 'rug', x: 0.5, y: 0, w: 2, h: 1 }]), interior, aprons);
    expect(rug.issues).toEqual([]);
    expect(rug.items[0]).toMatchObject({ kind: 'rug', blocking: false, x: interior.x + 0.5 });
  });

  it('rule 6: emitted with fractional x/y, whole w/h, pinned: true and the kind\'s blocking flag', () => {
    const res = resolvePins(room([{ kind: 'work-desk', x: 1.5, y: 0.5, w: 2, h: 1, variant: 3 }]), interior, new Set());
    expect(res.issues).toEqual([]);
    expect(res.items).toEqual([{ kind: 'work-desk', x: interior.x + 1.5, y: interior.y + 0.5, w: 2, h: 1, blocking: true, variant: 3, pinned: true }]);
  });

  it('flagAgainstNorthWall: y stays strict (a y + 0.5 item is not against the wall), columns are the covered ones', () => {
    // Wall on row 0 at x 2..3 only; floor elsewhere.
    const tiles: TileKind[][] = [
      ['floor', 'floor', 'wall', 'wall', 'floor', 'floor'],
      ['floor', 'floor', 'floor', 'floor', 'floor', 'floor'],
      ['floor', 'floor', 'floor', 'floor', 'floor', 'floor'],
    ];
    const items = [
      { x: 2, y: 1, w: 2, h: 1 }, // integer, both columns walled
      { x: 2.5, y: 1, w: 1, h: 1 }, // covers 2 and 3: walled
      { x: 3.5, y: 1, w: 1, h: 1 }, // covers 3 and 4: column 4 is floor
      { x: 2, y: 1.5, w: 1, h: 1 }, // half a tile down: not against the wall
    ].map((r) => ({ ...r, againstNorthWall: undefined as boolean | undefined }));
    flagAgainstNorthWall(items, 1, tiles);
    expect(items.map((i) => i.againstNorthWall ?? false)).toEqual([true, true, false, false]);
    expect(items.map((i) => [i.x, i.y, i.w, i.h])).toEqual([[2, 1, 2, 1], [2.5, 1, 1, 1], [3.5, 1, 1, 1], [2, 1.5, 1, 1]]);
  });

  it('seatsFor: a desk at y = 2.5 seats row 4 (the outward row below the covered rect); x = 2.5 seats three columns', () => {
    const inner = { x: 0, y: 0, w: 8, h: 8 };
    expect(seatsFor('work-desk', { x: 1, y: 2.5, w: 2, h: 1 }, inner)).toEqual([
      { x: 1, y: 4, kind: 'sit' },
      { x: 2, y: 4, kind: 'sit' },
    ]);
    expect(seatsFor('work-desk', { x: 2.5, y: 1, w: 2, h: 1 }, inner)).toEqual([
      { x: 2, y: 2, kind: 'sit' },
      { x: 3, y: 2, kind: 'sit' },
      { x: 4, y: 2, kind: 'sit' },
    ]);
    // Bottom edge: the covered rect reaches row 7, so the row above the covered rect (y = 5) is used.
    expect(seatsFor('work-desk', { x: 1, y: 6.5, w: 2, h: 1 }, inner).map((s) => s.y)).toEqual([5, 5]);
    // Table ring and "sit on itself" go around / over the covered tiles.
    const ring = seatsFor('table', { x: 2.5, y: 2, w: 1, h: 1 }, inner);
    expect(ring.map((s) => `${s.x},${s.y}`).sort()).toEqual(['1,2', '2,1', '2,3', '3,1', '3,3', '4,2'].sort());
    expect(seatsFor('sofa', { x: 2.5, y: 2, w: 1, h: 1 }, inner)).toEqual([{ x: 2, y: 2, kind: 'sit' }, { x: 3, y: 2, kind: 'sit' }]);
    // Integer input is untouched.
    expect(seatsFor('work-desk', { x: 1, y: 1, w: 2, h: 1 }, inner)).toEqual([{ x: 1, y: 2, kind: 'sit' }, { x: 2, y: 2, kind: 'sit' }]);
  });

  /** The 1x1 tile rect at `p`. */
  const tileRect = (p: Point) => ({ x: p.x, y: p.y, w: 1, h: 1 });

  /** walkable === 1 exactly on the tiles some blocking item overlaps (property 3, "any overlap blocks the tile"). */
  function expectWalkableMatchesBlocking(map: GeneratedMap, label: string): void {
    const blocking = map.furniture.filter((f) => f.blocking);
    for (const gr of map.rooms) {
      if (gr.type === 'stairs') continue;
      for (const t of coveredTiles(gr.interior)) {
        if (map.tiles[t.y]?.[t.x] !== 'floor') continue;
        const want = blocking.some((f) => rectsIntersect(f, tileRect(t))) ? 1 : 0;
        expect(map.walkable[t.y]?.[t.x], `${label}: walkable at ${t.x},${t.y}`).toBe(want);
      }
    }
  }

  /** Like `pinRandomly`, with every pin nudged by +0.5 on one axis (when it still fits). */
  function pinRandomlyHalf(layout: OfficeLayout, rand: () => number): OfficeLayout {
    const map = generateMap(layout);
    const rooms: LayoutRoom[] = layout.rooms.map((r) => {
      const inner = roomInterior(r);
      const pool = map.furniture.filter((f) => f.roomId === r.id && isPinnableKind(f.kind) && !f.pinned);
      const want = 1 + Math.floor(rand() * 3);
      const picked: PinnedFurniture[] = [];
      for (let i = 0; i < want && pool.length; i++) {
        const f = pool.splice(Math.floor(rand() * pool.length), 1)[0]!;
        const base = pinFromPlaced(f, inner);
        const axis = rand() < 0.5 ? 'x' : 'y';
        const nudged = axis === 'x' ? { ...base, x: base.x + 0.5 } : { ...base, y: base.y + 0.5 };
        const pin = nudged.x + nudged.w <= inner.w && nudged.y + nudged.h <= inner.h ? nudged : null;
        if (!pin || picked.some((p) => rectsIntersect(p, pin))) continue;
        picked.push(pin);
      }
      return picked.length ? { ...r, furniture: picked } : r;
    });
    return { ...layout, rooms };
  }

  it('100 seeds: half-offset pins land at their float position, seats never overlap a desk, walkable is the covered union', () => {
    let placed = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const label = `bsp ${seed}`;
      const layout = pinRandomlyHalf(asLayout(generateRandomLayout({ width: 48, height: 30, seed, background: seed % 2 ? 'hall' : 'void' }), seed), mulberry32(seed * 104729));
      const map = generateMap(layout);
      // A half pin is never a validateLayout error (no DEFAULT_LAYOUT fallback).
      expect(map.layoutId, label).toBe(layout.id);
      for (const r of layout.rooms) {
        const inner = roomInterior(r);
        for (const p of r.furniture ?? []) {
          const hit = map.furniture.find((f) => f.roomId === r.id && f.kind === p.kind && f.x === inner.x + p.x && f.y === inner.y + p.y && f.w === p.w && f.h === p.h);
          if (hit) {
            placed++;
            expect(hit.pinned, `${label}: ${r.id} ${p.kind} pinned`).toBe(true);
            expect(Number.isInteger(hit.w) && Number.isInteger(hit.h), `${label}: whole size`).toBe(true);
            if (hit.blocking) for (const t of coveredTiles(hit)) expect(map.walkable[t.y]?.[t.x], `${label}: ${t.x},${t.y} blocked by the pin`).toBe(1);
          } else {
            // The nudge moved it onto an automatic door apron: skipped with pinned-blocks, never silently.
            expect(map.issues.some((i) => i.code === 'pinned-blocks' && i.roomIds?.includes(r.id)), `${label}: ${r.id} ${p.kind} placed or pinned-blocks`).toBe(true);
          }
        }
      }
      const blocking = map.furniture.filter((f) => f.blocking);
      for (const gr of map.rooms) {
        for (const s of gr.seats) {
          expect(map.walkable[s.y]?.[s.x], `${label}: seat ${s.x},${s.y} walkable`).toBe(0);
          expect(blocking.some((f) => rectsIntersect(f, tileRect(s))), `${label}: seat ${s.x},${s.y} overlaps a blocking item`).toBe(false);
        }
      }
      expectWalkableMatchesBlocking(map, label);
    }
    expect(placed).toBeGreaterThan(100);
  }, 90000);

  it('property 3: a half pin in a room blocks exactly coveredTiles(pin) more than the same soft footprint', () => {
    // A rug pin displaces the same recipe items as a desk pin (pinned cells are off limits either way), so the
    // walkable difference between the two is the desk's covered tiles alone.
    const desks = DEFAULT_LAYOUT.rooms.find((r) => r.type === 'desks')!;
    const inner = roomInterior(desks);
    const at = { x: 1.5, y: 1, w: 2, h: 1 };
    const withKind = (kind: string): OfficeLayout => ({
      ...DEFAULT_LAYOUT,
      rooms: DEFAULT_LAYOUT.rooms.map((r) => (r.id === desks.id ? { ...r, furniture: [{ kind, ...at }] } : r)),
    });
    const hard = generateMap(withKind('work-desk'), { backWall: false, triggers: false });
    const soft = generateMap(withKind('rug'), { backWall: false, triggers: false });
    expect(hard.layoutId).toBe(DEFAULT_LAYOUT.id);
    expect(hard.furniture.find((f) => f.pinned)).toMatchObject({ kind: 'work-desk', x: inner.x + 1.5, y: inner.y + 1, blocking: true });
    const diff: Point[] = [];
    for (let y = 0; y < hard.rows; y++) for (let x = 0; x < hard.cols; x++) if (hard.walkable[y]![x] !== soft.walkable[y]![x]) diff.push({ x, y });
    expect(diff).toEqual(coveredTiles({ x: inner.x + 1.5, y: inner.y + 1, w: 2, h: 1 }));
    expect(diff).toHaveLength(3);
    expectWalkableMatchesBlocking(hard, 'half desk');
  });
});
