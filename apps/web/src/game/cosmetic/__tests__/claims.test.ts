import { describe, expect, it, vi } from 'vitest';
import { CosmeticClaims } from '../claims';

describe('CosmeticClaims', () => {
  it('claims a free key and refuses equal priority', () => {
    const c = new CosmeticClaims();
    expect(c.tryClaim('hero:a', 'drama', () => {})).toBe(true);
    expect(c.holder('hero:a')).toBe('drama');
    expect(c.isFree('hero:a')).toBe(false);
    expect(c.tryClaim('hero:a', 'activity', () => {})).toBe(false);
    expect(c.tryClaim('hero:a', 'drama', () => {})).toBe(false);
  });

  it('a higher priority revokes the holder synchronously, a lower never preempts', () => {
    const c = new CosmeticClaims();
    const revoke = vi.fn(() => expect(c.holder('hero:a')).toBeUndefined());
    c.tryClaim('hero:a', 'drama', revoke);
    expect(c.tryClaim('hero:a', 'reaction', () => {})).toBe(true);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('hero:a');
    expect(c.holder('hero:a')).toBe('reaction');
    expect(c.tryClaim('hero:a', 'drama', () => {})).toBe(false);
    expect(c.tryClaim('hero:a', 'meeting', () => {})).toBe(true);
    expect(c.tryClaim('hero:a', 'reaction', () => {})).toBe(false);
    expect(c.tryClaim('hero:a', 'meeting', () => {})).toBe(false);
  });

  it('release is a no-op for a non-holder', () => {
    const c = new CosmeticClaims();
    c.tryClaim('hero:a', 'meeting', () => {});
    c.release('hero:a', 'drama');
    expect(c.holder('hero:a')).toBe('meeting');
    c.release('hero:a', 'meeting');
    expect(c.isFree('hero:a')).toBe(true);
  });

  it('a revoke handler releasing its own kind does not drop the new claim', () => {
    const c = new CosmeticClaims();
    c.tryClaim('hero:a', 'drama', (k) => c.release(k, 'drama'));
    c.tryClaim('hero:a', 'meeting', () => {});
    expect(c.holder('hero:a')).toBe('meeting');
  });

  it('counts by kind', () => {
    const c = new CosmeticClaims();
    c.tryClaim('hero:a', 'drama', () => {});
    c.tryClaim('hero:b', 'drama', () => {});
    c.tryClaim('hero:c', 'meeting', () => {});
    expect(c.count()).toBe(3);
    expect(c.count('drama')).toBe(2);
    expect(c.count('reaction')).toBe(0);
  });

  it('reserves tiles once, released only by the reserving kind', () => {
    const c = new CosmeticClaims();
    expect(c.reserveTile({ x: 1, y: 2 }, 'drama')).toBe(true);
    expect(c.reserveTile({ x: 1, y: 2 }, 'meeting')).toBe(false);
    expect(c.isTileReserved({ x: 1, y: 2 })).toBe(true);
    c.releaseTile({ x: 1, y: 2 }, 'meeting');
    expect(c.isTileReserved({ x: 1, y: 2 })).toBe(true);
    c.releaseTile({ x: 1, y: 2 }, 'drama');
    expect(c.isTileReserved({ x: 1, y: 2 })).toBe(false);
  });

  it('clear drops everything without callbacks', () => {
    const c = new CosmeticClaims();
    const revoke = vi.fn();
    c.tryClaim('hero:a', 'drama', revoke);
    c.reserveTile({ x: 0, y: 0 }, 'drama');
    c.clear();
    expect(revoke).not.toHaveBeenCalled();
    expect(c.count()).toBe(0);
    expect(c.isTileReserved({ x: 0, y: 0 })).toBe(false);
  });
});
