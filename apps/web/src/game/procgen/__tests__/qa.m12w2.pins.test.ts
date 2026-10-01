import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, roomInterior, type OfficeLayout, type PinnedFurniture } from '@tagconn/shared';
import { generateMap } from '../generate';
import { TRIGGER_ORDER } from '../../furnitureTriggers';

const withPins = (layout: OfficeLayout, type: string, pins: PinnedFurniture[]): OfficeLayout => ({
  ...layout,
  rooms: layout.rooms.map((r) => (r.type === type ? { ...r, furniture: pins } : r)),
});

describe('QA M12 W2: adversarial pins', () => {
  it('a full-width wall of pinned bookcases across the desks room never throws or falls back to the default layout', () => {
    const base = { ...DEFAULT_LAYOUT, id: 'qa-wall', width: 48, height: 30 };
    const desks = base.rooms.find((r) => r.type === 'desks')!;
    const inner = roomInterior(desks);
    const pins: PinnedFurniture[] = [];
    for (let x = 0; x + 2 <= inner.w && pins.length < 48; x += 2) pins.push({ kind: 'bookcase', x, y: Math.floor(inner.h / 2), w: 2, h: 1 });
    const layout = withPins(base, 'desks', pins);
    const map = generateMap(layout);
    expect(map.cols).toBe(base.width);
    expect(map.furniture.filter((f) => f.pinned).length).toBe(pins.length);
  });

  it('pinning a second trigger-kind item (board) still yields at most one board trigger, and every action stays reachable', () => {
    const base = { ...DEFAULT_LAYOUT, id: 'qa-board' };
    const lib = base.rooms.find((r) => r.type === 'library') ?? base.rooms[1]!;
    const layout = withPins(base, lib.type, [
      { kind: 'board', x: 0, y: 0, w: 2, h: 1 },
      { kind: 'notice-board', x: 3, y: 0, w: 1, h: 1 },
    ]);
    const map = generateMap(layout);
    const acts = map.furniture.filter((f) => f.trigger).map((f) => f.trigger!);
    expect(new Set(acts).size).toBe(acts.length);
    // M14 T1: the infirmary only marks an existing coffee machine / water cooler, so it is not guaranteed.
    expect([...acts].filter((a) => a !== 'infirmary').sort()).toEqual(TRIGGER_ORDER.filter((a) => a !== 'infirmary').sort());
  });

  it('48 pins in one room (the cap) plus triggers still generate deterministically', () => {
    const base = { ...DEFAULT_LAYOUT, id: 'qa-cap' };
    const desks = base.rooms.find((r) => r.type === 'desks')!;
    const inner = roomInterior(desks);
    const pins: PinnedFurniture[] = [];
    for (let y = 0; y < inner.h && pins.length < 48; y += 2) for (let x = 0; x + 2 <= inner.w && pins.length < 48; x += 3) pins.push({ kind: 'work-desk', x, y, w: 2, h: 1 });
    const layout = withPins(base, 'desks', pins);
    expect(generateMap(layout)).toEqual(generateMap(layout));
  });
});
