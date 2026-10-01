import { describe, expect, it } from 'vitest';
import { overlayFromHash } from './overlays';

describe('overlayFromHash', () => {
  it('opens the matching overlay', () => {
    expect(overlayFromHash('#board')).toBe('board');
    expect(overlayFromHash('#settings')).toBe('settings');
  });
  it('returns null for the office, empty and unrelated hashes', () => {
    expect(overlayFromHash('')).toBeNull();
    expect(overlayFromHash('#office')).toBeNull();
    expect(overlayFromHash('#pair=ABCD-EFGH-JKMN')).toBeNull();
  });
});
