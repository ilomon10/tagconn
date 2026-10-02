import { describe, expect, it } from 'vitest';
import {
  coveredTileRect,
  coveredTiles,
  DEFAULT_LAYOUT,
  HALF_TILE,
  hasLayoutErrors,
  OfficeLayoutSchema,
  PinnedFurnitureSchema,
  rectsIntersect,
  validateLayout,
  type LayoutRoom,
} from '../layout.js';

const pin = (over: Partial<{ x: number; y: number; w: number; h: number }> = {}) => ({ kind: 'plant', x: 1, y: 1, w: 1, h: 1, ...over });

describe('PinnedFurnitureSchema (M15 half-tile positions)', () => {
  it('exposes the half-tile unit', () => {
    expect(HALF_TILE).toBe(0.5);
  });

  it('accepts whole and half positions', () => {
    for (const p of [pin(), pin({ x: 2.5 }), pin({ y: 0.5 }), pin({ x: 0, y: 3.5 }), pin({ x: 127.5, y: 95.5 })]) {
      expect(PinnedFurnitureSchema.safeParse(p).success, JSON.stringify(p)).toBe(true);
    }
  });

  it('rejects values just off the half grid that a float-tolerant multipleOf would accept', () => {
    for (const v of [2.500000000000001, 0.5000000000000001, 0.49999999999999994, 1.0000000000000002, 63.50000000000001, 5e-324]) {
      expect(PinnedFurnitureSchema.safeParse(pin({ x: v })).success, `x=${v}`).toBe(false);
      expect(PinnedFurnitureSchema.safeParse(pin({ y: v })).success, `y=${v}`).toBe(false);
    }
    expect(PinnedFurnitureSchema.safeParse(pin({ x: -0 })).success).toBe(true);
  });

  it('rejects quarter positions and negative ones', () => {
    for (const p of [pin({ x: 0.25 }), pin({ y: 1.75 }), pin({ x: 2.1 }), pin({ x: -0.5 })]) {
      expect(PinnedFurnitureSchema.safeParse(p).success, JSON.stringify(p)).toBe(false);
    }
  });

  it('keeps sizes whole tiles', () => {
    expect(PinnedFurnitureSchema.safeParse(pin({ w: 1.5 })).success).toBe(false);
    expect(PinnedFurnitureSchema.safeParse(pin({ h: 2.5 })).success).toBe(false);
    expect(PinnedFurnitureSchema.safeParse(pin({ w: 2, h: 3 })).success).toBe(true);
  });

  it('parses an old integer layout unchanged', () => {
    const rooms = DEFAULT_LAYOUT.rooms.map((r, i) => (i === 0 ? { ...r, furniture: [pin(), pin({ x: 3, y: 2, w: 2, h: 1 })] } : r));
    const layout = { ...DEFAULT_LAYOUT, rooms };
    const parsed = OfficeLayoutSchema.parse(layout);
    expect(parsed).toEqual(layout);
    expect(hasLayoutErrors(validateLayout(parsed))).toBe(false);
  });
});

describe('coveredTileRect / coveredTiles', () => {
  it('maps integer rects to themselves', () => {
    const r = { x: 3, y: 4, w: 2, h: 1 };
    expect(coveredTileRect(r)).toEqual(r);
    expect(coveredTiles(r)).toEqual([
      { x: 3, y: 4 },
      { x: 4, y: 4 },
    ]);
  });

  it('grows a half-offset rect to every tile it touches', () => {
    expect(coveredTileRect({ x: 2.5, y: 1, w: 1, h: 1 })).toEqual({ x: 2, y: 1, w: 2, h: 1 });
    expect(coveredTileRect({ x: 2.5, y: 1.5, w: 2, h: 1 })).toEqual({ x: 2, y: 1, w: 3, h: 2 });
    expect(coveredTiles({ x: 0.5, y: 0.5, w: 1, h: 1 })).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]);
  });

  it('returns an empty rect and no tiles for an empty footprint', () => {
    expect(coveredTileRect({ x: 1.5, y: 2, w: 0, h: 1 })).toEqual({ x: 1, y: 2, w: 0, h: 0 });
    expect(coveredTiles({ x: 1, y: 2, w: 1, h: 0 })).toEqual([]);
  });

  it('agrees with rectsIntersect on the tiles it covers', () => {
    const r = { x: 1.5, y: 0.5, w: 1, h: 2 };
    for (const t of coveredTiles(r)) expect(rectsIntersect(r, { ...t, w: 1, h: 1 })).toBe(true);
    expect(rectsIntersect(r, { x: 3, y: 0, w: 1, h: 1 })).toBe(false);
  });
});

describe('validateLayout with half-tile pins', () => {
  /** A walled 7x6 room: interior 5x4, one N door at offset 2 (interior tile x=1, y=0). */
  const room = (furniture: LayoutRoom['furniture']): LayoutRoom => ({
    id: 'r',
    type: 'meeting-room',
    x: 1,
    y: 1,
    w: 7,
    h: 7,
    doors: [{ side: 'n', offset: 2 }],
    furniture,
  });
  const layoutWith = (furniture: LayoutRoom['furniture']) => ({
    width: 24,
    height: 16,
    rooms: [
      room(furniture),
      { id: 'e', type: 'entrance', x: 10, y: 1, w: 4, h: 4 } as LayoutRoom,
      { id: 's', type: 'stairs', x: 16, y: 1, w: 2, h: 2 } as LayoutRoom,
    ],
  });
  const pinnedIssues = (furniture: LayoutRoom['furniture']) => validateLayout(layoutWith(furniture)).filter((i) => i.code === 'pinned-invalid');

  it('flags a half-offset pin whose covered tiles include the door apron', () => {
    // Apron tile is interior (1, 0). A pin at x=0.5 covers tiles 0 and 1 of row 0.
    expect(pinnedIssues([pin({ x: 0.5, y: 0 })]).map((i) => i.message)).toEqual(['meeting-room: a locked plant blocks a door.']);
    // y=0.5 still touches row 0.
    expect(pinnedIssues([pin({ x: 1, y: 0.5 })])).toHaveLength(1);
  });

  it('accepts a half-offset pin that stays clear of the apron and the walls', () => {
    expect(pinnedIssues([pin({ x: 2.5, y: 1.5 })])).toEqual([]);
    expect(pinnedIssues([pin({ x: 2, y: 0 })])).toEqual([]);
  });

  it('flags a half-offset pin that pokes out of the interior', () => {
    // Interior is 5 wide: x=4.5 + w 1 > 5.
    expect(pinnedIssues([pin({ x: 4.5, y: 2 })]).map((i) => i.message)).toEqual(['meeting-room: a locked plant sits outside the room.']);
  });

  it('flags two pins overlapping by half a tile', () => {
    expect(pinnedIssues([pin({ x: 2, y: 2 }), pin({ x: 2.5, y: 2 })]).map((i) => i.message)).toEqual(['meeting-room: two locked items overlap.']);
    expect(pinnedIssues([pin({ x: 2, y: 2 }), pin({ x: 3, y: 2 })])).toEqual([]);
  });
});
