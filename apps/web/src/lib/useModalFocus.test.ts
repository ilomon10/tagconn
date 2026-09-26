import { describe, expect, it } from 'vitest';
import { initialFocusTarget, isEditableTarget, trapFocusTarget } from './useModalFocus';

/**
 * `initialFocusTarget` and `trapFocusTarget` are the pure decisions inside `useModalFocus` (M9 8f):
 * the hook itself needs a real DOM and a React render to exercise (there's no jsdom in this
 * workspace — see `hooks.test.ts`'s `themedRoleInfo` for the same split), but "which element should
 * get focus" is plain data in, data out, so it's tested directly with stand-in "elements" (plain
 * objects compared by identity — the real hook passes actual `HTMLElement`s).
 */
describe('initialFocusTarget', () => {
  const first = { name: 'first' };
  const other = { name: 'other' };

  it('prefers the explicit initial target over the first focusable', () => {
    expect(initialFocusTarget(other, [first, other])).toBe(other);
  });

  it('falls back to the first focusable when no initial target is given', () => {
    expect(initialFocusTarget(null, [first, other])).toBe(first);
    expect(initialFocusTarget(undefined, [first, other])).toBe(first);
  });

  it('returns null when there is nothing to focus at all', () => {
    expect(initialFocusTarget(null, [])).toBeNull();
  });
});

describe('trapFocusTarget', () => {
  const first = { name: 'first' };
  const middle = { name: 'middle' };
  const last = { name: 'last' };
  const outside = { name: 'outside' };
  const focusables = [first, middle, last];

  it('returns null when the container has nothing focusable', () => {
    expect(trapFocusTarget([], null, false, false)).toBeNull();
  });

  it('Tab from the last focusable wraps to the first', () => {
    expect(trapFocusTarget(focusables, last, true, false)).toBe(first);
  });

  it('Shift+Tab from the first focusable wraps to the last', () => {
    expect(trapFocusTarget(focusables, first, true, true)).toBe(last);
  });

  it('leaves the browser default alone when Tab is in the middle of the container', () => {
    expect(trapFocusTarget(focusables, middle, true, false)).toBeNull();
    expect(trapFocusTarget(focusables, middle, true, true)).toBeNull();
  });

  it('pulls focus back in when it somehow left the container', () => {
    expect(trapFocusTarget(focusables, outside, false, false)).toBe(first);
    expect(trapFocusTarget(focusables, outside, false, true)).toBe(last);
  });

  it('keeps focus on the only focusable element in either direction', () => {
    expect(trapFocusTarget([first], first, true, false)).toBe(first);
    expect(trapFocusTarget([first], first, true, true)).toBe(first);
  });
});

describe('isEditableTarget', () => {
  it('treats inputs, textareas, selects and contenteditable as fields that own Esc', () => {
    expect(isEditableTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });
  it('lets Esc close the dialog from buttons and plain elements', () => {
    expect(isEditableTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
