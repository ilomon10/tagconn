import { describe, expect, it } from 'vitest';
import { isTypingTarget, resolveShortcut, type KeyLike } from './shortcuts';

const key = (over: Partial<KeyLike> & Pick<KeyLike, 'key'>): KeyLike => ({
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  target: null,
  ...over,
});

describe('isTypingTarget', () => {
  it('is true for input, textarea, select and contenteditable', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'SELECT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('is false for other elements, and for null/undefined', () => {
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });
});

describe('resolveShortcut', () => {
  it('is ignored entirely while the user is typing', () => {
    expect(resolveShortcut(key({ key: 'Delete', target: { tagName: 'INPUT' } }))).toBeNull();
    expect(resolveShortcut(key({ key: 'z', ctrlKey: true, target: { tagName: 'TEXTAREA' } }))).toBeNull();
  });

  it('maps undo / redo, incl. Ctrl+Shift+Z and Ctrl+Y', () => {
    expect(resolveShortcut(key({ key: 'z', ctrlKey: true }))).toEqual({ type: 'undo' });
    expect(resolveShortcut(key({ key: 'z', metaKey: true }))).toEqual({ type: 'undo' });
    expect(resolveShortcut(key({ key: 'z', ctrlKey: true, shiftKey: true }))).toEqual({ type: 'redo' });
    expect(resolveShortcut(key({ key: 'y', ctrlKey: true }))).toEqual({ type: 'redo' });
  });

  it('maps Delete/Backspace, Escape, save and duplicate', () => {
    expect(resolveShortcut(key({ key: 'Delete' }))).toEqual({ type: 'delete' });
    expect(resolveShortcut(key({ key: 'Backspace' }))).toEqual({ type: 'delete' });
    expect(resolveShortcut(key({ key: 'Escape' }))).toEqual({ type: 'escape' });
    expect(resolveShortcut(key({ key: 's', ctrlKey: true }))).toEqual({ type: 'save' });
    expect(resolveShortcut(key({ key: 'd', metaKey: true }))).toEqual({ type: 'duplicate' });
    expect(resolveShortcut(key({ key: 'g', ctrlKey: true }))).toEqual({ type: 'surprise' });
  });

  it('maps tool hotkeys, but only unmodified (Ctrl+S is Save, not the Stairs tool)', () => {
    expect(resolveShortcut(key({ key: 'v' }))).toEqual({ type: 'tool', tool: 'select' });
    expect(resolveShortcut(key({ key: 'r' }))).toEqual({ type: 'tool', tool: 'room' });
    expect(resolveShortcut(key({ key: 's' }))).toEqual({ type: 'tool', tool: 'stairs' });
    expect(resolveShortcut(key({ key: 'h' }))).toEqual({ type: 'tool', tool: 'hand' });
    expect(resolveShortcut(key({ key: ' ' }))).toEqual({ type: 'tool', tool: 'hand' });
    expect(resolveShortcut(key({ key: 's', ctrlKey: true }))).toEqual({ type: 'save' });
  });

  it('maps the 1-9/0 room-type hotkeys', () => {
    expect(resolveShortcut(key({ key: '1' }))).toEqual({ type: 'room-type', index: 0 });
    expect(resolveShortcut(key({ key: '9' }))).toEqual({ type: 'room-type', index: 8 });
    expect(resolveShortcut(key({ key: '0' }))).toEqual({ type: 'room-type', index: 9 });
  });

  it('maps arrow nudge with Shift for 5x and Alt for resize', () => {
    expect(resolveShortcut(key({ key: 'ArrowRight' }))).toEqual({ type: 'nudge', dx: 1, dy: 0, resize: false });
    expect(resolveShortcut(key({ key: 'ArrowUp', shiftKey: true }))).toEqual({ type: 'nudge', dx: 0, dy: -5, resize: false });
    expect(resolveShortcut(key({ key: 'ArrowDown', altKey: true }))).toEqual({ type: 'nudge', dx: 0, dy: 1, resize: true });
  });

  it('leaves unmodified keys and unhandled modifier combos as null', () => {
    expect(resolveShortcut(key({ key: 'q' }))).toBeNull();
    expect(resolveShortcut(key({ key: 'r', ctrlKey: true }))).toBeNull();
  });
});
