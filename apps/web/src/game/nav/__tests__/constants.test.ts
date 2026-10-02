import { describe, expect, it } from 'vitest';
import { TILE } from '../../procgen/generate';
import { BITS_PER_TILE, CELL_PX, CLEARANCE_MAX, FEET_DY, FULL_MASK, SUB, TILE_FLAG_DOOR, TILE_FLAG_FLOOR, TILE_FLAG_SOFT, TILE_PX } from '../constants';

describe('nav constants', () => {
  it('TILE_PX matches the procgen tile size', () => {
    expect(TILE_PX).toBe(TILE);
  });

  it('derives the cell size and mask width from SUB', () => {
    expect(SUB).toBe(2);
    expect(CELL_PX).toBe(8);
    expect(BITS_PER_TILE).toBe(4);
    expect(FULL_MASK).toBe(0xf);
    expect(CLEARANCE_MAX).toBe(7);
    expect(FEET_DY).toBe(6);
  });

  it('keeps the tile flags in the high nibble, clear of the cell bits', () => {
    for (const flag of [TILE_FLAG_FLOOR, TILE_FLAG_DOOR, TILE_FLAG_SOFT]) expect(flag & FULL_MASK).toBe(0);
    expect(TILE_FLAG_FLOOR | TILE_FLAG_DOOR | TILE_FLAG_SOFT).toBe(0x70);
  });
});
