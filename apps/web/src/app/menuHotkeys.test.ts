import { describe, expect, it } from 'vitest';
import { MENU_HOTKEYS, menuActionForKey } from './menuHotkeys';

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('menuActionForKey', () => {
  it('maps a letter, case-insensitively', () => {
    expect(menuActionForKey(key('b'))).toBe('board');
    expect(menuActionForKey(key('B'))).toBe('board');
    expect(menuActionForKey(key('m'))).toBe('menu');
  });
  it('ignores modified keys and non-letters', () => {
    expect(menuActionForKey(key('b', { ctrlKey: true }))).toBeNull();
    expect(menuActionForKey(key('s', { metaKey: true }))).toBeNull();
    expect(menuActionForKey(key('PageUp'))).toBeNull();
    expect(menuActionForKey(key('['))).toBeNull();
  });
  it('leaves F to the floor manager hotkey', () => {
    expect(menuActionForKey(key('f'))).toBeNull();
  });
  it('uses a unique key per action', () => {
    const keys = Object.values(MENU_HOTKEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
