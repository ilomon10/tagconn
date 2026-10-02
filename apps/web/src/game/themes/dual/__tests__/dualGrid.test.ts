import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '@tagconn/shared';
import { generateMap } from '../../../procgen';
import {
  BIT,
  buildDualCell,
  buildDualCells,
  cellOrigin,
  cornerKind,
  cornerKinds,
  faceMask,
  isUniform,
  makeFloorKindAt,
  makeKindAt,
  maskOf,
  QUADRANTS,
  quadrantRect,
  quadrantTile,
} from '../dualGrid';
import { HALF_EDGE_QUADRANTS } from '../dualGeom';
import { cellFrom, tilesFrom, tinyMap, withDoor } from './fixtures';

describe('dualGrid (W0 pure helpers)', () => {
  it('mask bits are tl<<3 | tr<<2 | bl<<1 | br', () => {
    expect(BIT).toEqual({ tl: 8, tr: 4, bl: 2, br: 1 });
    expect(QUADRANTS.reduce((m, q) => m | BIT[q], 0)).toBe(0xf);
  });

  it('quadrantTile samples the four tiles around the corner (cx, cy)', () => {
    const cell = { cx: 3, cy: 5 };
    expect(quadrantTile(cell, 'tl')).toEqual({ x: 2, y: 4 });
    expect(quadrantTile(cell, 'tr')).toEqual({ x: 3, y: 4 });
    expect(quadrantTile(cell, 'bl')).toEqual({ x: 2, y: 5 });
    expect(quadrantTile(cell, 'br')).toEqual({ x: 3, y: 5 });
    // The border cell samples off-map tiles (negative coordinates), which callers treat as void.
    expect(quadrantTile({ cx: 0, cy: 0 }, 'tl')).toEqual({ x: -1, y: -1 });
  });

  it('cellOrigin is half a tile up and left of the corner', () => {
    expect(cellOrigin({ cx: 0, cy: 0 }, 16)).toEqual({ px: -8, py: -8 });
    expect(cellOrigin({ cx: 2, cy: 1 }, 16)).toEqual({ px: 24, py: 8 });
  });

  it('quadrantRect tiles the cell with four T/2 squares', () => {
    const cell = { cx: 2, cy: 1 };
    expect(quadrantRect(cell, 'tl', 16)).toEqual({ x: 24, y: 8, w: 8, h: 8 });
    expect(quadrantRect(cell, 'tr', 16)).toEqual({ x: 32, y: 8, w: 8, h: 8 });
    expect(quadrantRect(cell, 'bl', 16)).toEqual({ x: 24, y: 16, w: 8, h: 8 });
    expect(quadrantRect(cell, 'br', 16)).toEqual({ x: 32, y: 16, w: 8, h: 8 });
  });

  it('cornerKind: off-map and void are void, door is floor', () => {
    expect(cornerKind(undefined)).toBe('void');
    expect(cornerKind('void')).toBe('void');
    expect(cornerKind('wall')).toBe('wall');
    expect(cornerKind('floor')).toBe('floor');
    expect(cornerKind('door')).toBe('floor');
  });
});

describe('dualGrid (D0 model)', () => {
  it('HALF_EDGE_QUADRANTS lists the n/w quadrant first and covers every quadrant twice', () => {
    expect(HALF_EDGE_QUADRANTS).toEqual({ n: ['tl', 'tr'], e: ['tr', 'br'], s: ['bl', 'br'], w: ['tl', 'bl'] });
    const seen = Object.values(HALF_EDGE_QUADRANTS).flat();
    for (const q of QUADRANTS) expect(seen.filter((x) => x === q)).toHaveLength(2);
  });

  it('makeKindAt: off-map and void are void, door is floor', () => {
    const kindAt = makeKindAt(tilesFrom(['#D', '. ']));
    expect(kindAt(0, 0)).toBe('wall');
    expect(kindAt(1, 0)).toBe('floor');
    expect(kindAt(0, 1)).toBe('floor');
    expect(kindAt(1, 1)).toBe('void');
    expect(kindAt(-1, 0)).toBe('void');
    expect(kindAt(0, 2)).toBe('void');
    expect(kindAt(2, 0)).toBe('void');
  });

  it('makeFloorKindAt follows the renderTheme rule: room type, else corridor with void, else hall', () => {
    const withVoid = tinyMap();
    const kind = makeFloorKindAt(withVoid);
    expect(kind(2, 2)).toBe('desks');
    expect(kind(3, 4)).toBe('desks'); // the door tile is inside the room rect
    expect(kind(1, 5)).toBe('corridor');
    const noVoid = tilesFrom(['....', '....'], [{ id: 'r', type: 'lounge', rect: { x: 0, y: 0, w: 2, h: 2 } }]);
    const kind2 = makeFloorKindAt(noVoid);
    expect(kind2(0, 0)).toBe('lounge');
    expect(kind2(3, 1)).toBe('hall');
  });

  it('cornerKinds and maskOf', () => {
    const kindAt = makeKindAt(tilesFrom(['#.', ' D']));
    const kinds = cornerKinds(kindAt, 1, 1);
    expect(kinds).toEqual({ tl: 'wall', tr: 'floor', bl: 'void', br: 'floor' });
    expect(maskOf(kinds, 'wall')).toBe(BIT.tl);
    expect(maskOf(kinds, 'floor')).toBe(BIT.tr | BIT.br);
    expect(maskOf(kinds, 'void')).toBe(BIT.bl);
    expect(maskOf(kinds, 'wall') | maskOf(kinds, 'floor') | maskOf(kinds, 'void')).toBe(0xf);
  });

  it('buildDualCell records door quadrants, floor kinds and room ids', () => {
    const map = tinyMap();
    const cell = buildDualCell(map, 3, 5, makeKindAt(map), makeFloorKindAt(map));
    // tl = (2,4) wall, tr = (3,4) door, bl = (2,5) corridor floor, br = (3,5) corridor floor.
    expect(cell.kinds).toEqual({ tl: 'wall', tr: 'floor', bl: 'floor', br: 'floor' });
    expect(cell.wallMask).toBe(BIT.tl);
    expect(cell.floorMask).toBe(BIT.tr | BIT.bl | BIT.br);
    expect(cell.voidMask).toBe(0);
    expect(cell.doorMask).toBe(BIT.tr);
    expect(cell.floorKinds).toEqual({ tl: null, tr: 'desks', bl: 'corridor', br: 'corridor' });
    expect(cell.roomIds).toEqual({ tl: null, tr: 'r1', bl: null, br: null });
  });

  it('masks partition 0xf and doorMask is a subset of floorMask on DEFAULT_LAYOUT', () => {
    const map = generateMap(DEFAULT_LAYOUT);
    const cells = buildDualCells(map);
    let doors = 0;
    for (const c of cells) {
      expect(c.wallMask & c.floorMask).toBe(0);
      expect(c.wallMask & c.voidMask).toBe(0);
      expect(c.floorMask & c.voidMask).toBe(0);
      expect(c.wallMask | c.floorMask | c.voidMask).toBe(0xf);
      expect(c.doorMask & ~c.floorMask).toBe(0);
      if (c.doorMask) doors++;
      for (const q of QUADRANTS) {
        expect(c.floorKinds[q] === null).toBe(c.kinds[q] !== 'floor');
        if (c.kinds[q] !== 'floor') expect(c.roomIds[q]).toBeNull();
      }
    }
    expect(doors).toBeGreaterThan(0);
  });

  it('off-map quadrants are void on every border cell', () => {
    const map = tilesFrom(['###', '#.#', '###']);
    const cells = buildDualCells(map);
    for (const c of cells) {
      if (c.cx === 0) expect(c.kinds.tl === 'void' && c.kinds.bl === 'void').toBe(true);
      if (c.cx === map.cols) expect(c.kinds.tr === 'void' && c.kinds.br === 'void').toBe(true);
      if (c.cy === 0) expect(c.kinds.tl === 'void' && c.kinds.tr === 'void').toBe(true);
      if (c.cy === map.rows) expect(c.kinds.bl === 'void' && c.kinds.br === 'void').toBe(true);
    }
    expect(cells[0]!.voidMask).toBe(BIT.tl | BIT.tr | BIT.bl);
    expect(cells[0]!.wallMask).toBe(BIT.br);
  });

  it('buildDualCells is (cols+1)*(rows+1) in row-major order', () => {
    const map = tilesFrom(['##', '..', '  ']);
    const cells = buildDualCells(map);
    expect(cells).toHaveLength((map.cols + 1) * (map.rows + 1));
    cells.forEach((c, i) => {
      expect(c.cx).toBe(i % (map.cols + 1));
      expect(c.cy).toBe(Math.floor(i / (map.cols + 1)));
    });
    const big = generateMap(DEFAULT_LAYOUT);
    expect(buildDualCells(big)).toHaveLength((big.cols + 1) * (big.rows + 1));
  });

  it('isUniform on all-wall, all-floor, floor+door, all-void and mixed cells', () => {
    expect(isUniform(cellFrom('####'))).toBe(true);
    expect(isUniform(cellFrom('....'))).toBe(true);
    expect(isUniform(cellFrom('..D.'))).toBe(true);
    expect(isUniform(withDoor(cellFrom('....'), 'br'))).toBe(true);
    expect(isUniform(cellFrom('    '))).toBe(true);
    expect(isUniform(cellFrom('##..'))).toBe(false);
    expect(isUniform(cellFrom('#   '))).toBe(false);
    expect(isUniform(cellFrom('#.# '))).toBe(false);
  });

  it('faceMask: wall over floor/door in the same column, zero elsewhere', () => {
    expect(faceMask(cellFrom('##..'))).toBe(BIT.tl | BIT.tr);
    expect(faceMask(cellFrom('#..#'))).toBe(BIT.tl);
    expect(faceMask(cellFrom('.#..'))).toBe(BIT.tr);
    expect(faceMask(cellFrom('##.D'))).toBe(BIT.tl | BIT.tr);
    expect(faceMask(cellFrom('##D#'))).toBe(BIT.tl);
    expect(faceMask(cellFrom('..##'))).toBe(0); // floor over wall is not a face
    expect(faceMask(cellFrom('## #'))).toBe(0); // wall over void / wall
    expect(faceMask(cellFrom('####'))).toBe(0);
    expect(faceMask(cellFrom('....'))).toBe(0);
    expect(faceMask(cellFrom('#.#.'))).toBe(0); // wall left of floor is not a face
  });

  it('cellFrom sets masks from the spec and withDoor only accepts floor quadrants', () => {
    const c = cellFrom('# D.', { cx: 4, cy: 2, floorKind: 'lounge', roomId: 'r9' });
    expect(c).toMatchObject({ cx: 4, cy: 2, wallMask: BIT.tl, voidMask: BIT.tr, floorMask: BIT.bl | BIT.br, doorMask: BIT.bl });
    expect(c.floorKinds).toEqual({ tl: null, tr: null, bl: 'lounge', br: 'lounge' });
    expect(c.roomIds).toEqual({ tl: null, tr: null, bl: 'r9', br: 'r9' });
    expect(() => withDoor(c, 'tl')).toThrow();
    expect(() => cellFrom('###')).toThrow();
  });
});
