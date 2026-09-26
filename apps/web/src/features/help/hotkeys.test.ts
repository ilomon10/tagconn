import { describe, expect, it } from 'vitest';
import { shouldOpenHelp, type KeyLike } from './hotkeys';

// The test environment has no DOM (`environment: 'node'`, see `vitest.config.ts`), so `shouldOpenHelp`
// takes an injectable `doc` — the same pattern `lib/floors.test.ts` uses for `isModalOpen`.
const fakeDoc = (modalOpen: boolean): Document => ({ querySelector: () => (modalOpen ? ({} as Element) : null) }) as unknown as Document;

function key(overrides: Partial<KeyLike> = {}): KeyLike {
  return { key: '?', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, target: null, ...overrides };
}

describe('shouldOpenHelp', () => {
  it('opens on "?" with no modifier, outside a typing target, with no modal open', () => {
    expect(shouldOpenHelp(key(), fakeDoc(false))).toBe(true);
  });

  it('opens on Shift+/ (some layouts report key "/" with shiftKey rather than "?")', () => {
    expect(shouldOpenHelp(key({ key: '/', shiftKey: true }), fakeDoc(false))).toBe(true);
  });

  it('ignores an unrelated key', () => {
    expect(shouldOpenHelp(key({ key: 'a' }), fakeDoc(false))).toBe(false);
  });

  it('ignores "/" without shift (not the help combo)', () => {
    expect(shouldOpenHelp(key({ key: '/', shiftKey: false }), fakeDoc(false))).toBe(false);
  });

  it('is ignored while typing (input, textarea, select, contenteditable)', () => {
    expect(shouldOpenHelp(key({ target: { tagName: 'INPUT' } as unknown as EventTarget }), fakeDoc(false))).toBe(false);
    expect(shouldOpenHelp(key({ target: { tagName: 'TEXTAREA' } as unknown as EventTarget }), fakeDoc(false))).toBe(false);
    expect(shouldOpenHelp(key({ target: { tagName: 'SELECT' } as unknown as EventTarget }), fakeDoc(false))).toBe(false);
    expect(shouldOpenHelp(key({ target: { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget }), fakeDoc(false))).toBe(false);
  });

  it('is ignored while another modal (e.g. the Hall Planner) is already open', () => {
    expect(shouldOpenHelp(key(), fakeDoc(true))).toBe(false);
  });

  it('is ignored with a Ctrl/Cmd/Alt modifier held', () => {
    expect(shouldOpenHelp(key({ ctrlKey: true }), fakeDoc(false))).toBe(false);
    expect(shouldOpenHelp(key({ metaKey: true }), fakeDoc(false))).toBe(false);
    expect(shouldOpenHelp(key({ altKey: true }), fakeDoc(false))).toBe(false);
  });
});
