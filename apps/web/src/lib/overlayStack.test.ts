import { describe, expect, it } from 'vitest';
import { escapeIgnoresTarget, escapeTarget, overlayCount, pushOverlay } from './overlayStack';

const esc = (target?: { tagName: string; type?: string; isContentEditable?: boolean }, extra: { defaultPrevented?: boolean } = {}) => ({ key: 'Escape', target: target as unknown as EventTarget, ...extra });

describe('escapeTarget', () => {
  const bottom = { name: 'panel' };
  const top = { name: 'dialog' };

  it('picks the top-most overlay only', () => {
    expect(escapeTarget([bottom, top], esc())).toBe(top);
    expect(escapeTarget([bottom], esc())).toBe(bottom);
  });
  it('does nothing when no overlay is open, for other keys, or when already handled', () => {
    expect(escapeTarget([], esc())).toBeNull();
    expect(escapeTarget([top], { key: 'Enter' })).toBeNull();
    expect(escapeTarget([top], esc(undefined, { defaultPrevented: true }))).toBeNull();
  });
  it('leaves Esc to text fields (rename, search)', () => {
    expect(escapeTarget([top], esc({ tagName: 'INPUT', type: 'text' }))).toBeNull();
    expect(escapeTarget([top], esc({ tagName: 'TEXTAREA' }))).toBeNull();
    expect(escapeTarget([top], esc({ tagName: 'DIV', isContentEditable: true }))).toBeNull();
  });
  it('still closes from buttons, checkboxes and selects', () => {
    expect(escapeTarget([top], esc({ tagName: 'BUTTON' }))).toBe(top);
    expect(escapeTarget([top], esc({ tagName: 'INPUT', type: 'checkbox' }))).toBe(top);
    expect(escapeTarget([top], esc({ tagName: 'SELECT' }))).toBe(top);
  });
});

describe('escapeIgnoresTarget', () => {
  it('is false for no target or a non-element', () => {
    expect(escapeIgnoresTarget(null)).toBe(false);
    expect(escapeIgnoresTarget({} as EventTarget)).toBe(false);
  });
});

describe('pushOverlay', () => {
  it('adds and removes entries, in any order', () => {
    const a = pushOverlay({ close: () => {} });
    const b = pushOverlay({ close: () => {} });
    expect(overlayCount()).toBe(2);
    a();
    expect(overlayCount()).toBe(1);
    b();
    b();
    expect(overlayCount()).toBe(0);
  });
});
