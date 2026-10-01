import { afterEach, describe, expect, it, vi } from 'vitest';
import { sfxBus, type SfxId } from '../../../game/sfxBus';
import { CLOSE_OPEN_WINDOW_MS, clickSoundFor, insideTopModal, installUiSoundDelegate, resetUiSound, selectionSound, uiSound } from '../uiSound';

/** Minimal element: matches a set of selectors, carries attributes, and `closest` walks parents. */
interface Fake { selectors: string[]; attrs: Record<string, string>; parent?: Fake }
interface FakeEl { matches(sel: string): boolean; getAttribute(n: string): string | null; closest(sel: string): FakeEl | null }
function el(f: Fake): FakeEl {
  const node: FakeEl = {
    matches: (sel: string) => sel.split(',').some((s) => f.selectors.includes(s.trim())),
    getAttribute: (n: string) => f.attrs[n] ?? null,
    closest: (sel) => {
      if (node.matches(sel) || (sel === '[data-sfx]' && 'data-sfx' in f.attrs)) return node;
      return f.parent ? el(f.parent).closest(sel) : null;
    },
  };
  return node;
}
const button = (attrs: Record<string, string> = {}, extra: string[] = [], parent?: Fake): Fake => ({ selectors: ['button', ...extra], attrs, parent });

describe('clickSoundFor', () => {
  it('clicks a plain button', () => {
    expect(clickSoundFor(el(button()) as never)).toBe('ui-click');
  });
  it('ignores non-controls and disabled controls', () => {
    expect(clickSoundFor(el({ selectors: ['div'], attrs: {} }) as never)).toBeNull();
    expect(clickSoundFor(el(button({}, [':disabled'])) as never)).toBeNull();
    expect(clickSoundFor(null)).toBeNull();
  });
  it('honours data-sfx none and override, also from an ancestor', () => {
    expect(clickSoundFor(el(button({ 'data-sfx': 'none' })) as never)).toBeNull();
    expect(clickSoundFor(el(button({ 'data-sfx': 'ui-confirm' })) as never)).toBe('ui-confirm');
    expect(clickSoundFor(el(button({}, [], { selectors: ['section'], attrs: { 'data-sfx': 'none' } })) as never)).toBeNull();
    expect(clickSoundFor(el(button({ 'data-sfx': 'bogus' })) as never)).toBe('ui-click');
  });
  it('maps switches, checkboxes and tabs', () => {
    expect(clickSoundFor(el(button({ role: 'switch' })) as never)).toBe('ui-toggle');
    expect(clickSoundFor(el({ selectors: ['input[type="checkbox"]'], attrs: {} }) as never)).toBe('ui-toggle');
    expect(clickSoundFor(el(button({ role: 'tab' })) as never)).toBe('ui-tab');
  });
});

describe('selectionSound', () => {
  it('selects, switches and clears', () => {
    expect(selectionSound(null, 'a')).toBe('ui-select');
    expect(selectionSound('a', 'b')).toBe('ui-select');
    expect(selectionSound('a', null)).toBe('ui-back');
    expect(selectionSound('a', 'a')).toBeNull();
    expect(selectionSound(null, null)).toBeNull();
  });
});

describe('delegate', () => {
  afterEach(() => sfxBus.clear());
  function setup(now: () => number) {
    const handlers: Record<string, (e: unknown) => void> = {};
    const doc = {
      addEventListener: (t: string, h: (e: unknown) => void) => void (handlers[t] = h),
      removeEventListener: (t: string) => void delete handlers[t],
    };
    const heard: SfxId[] = [];
    sfxBus.on((e) => heard.push(e.id));
    const off = installUiSoundDelegate(doc as never, now);
    return { handlers, heard, off };
  }
  it('plays the generic click, and not after a semantic sound in the same interaction', () => {
    let t = 1_000_000;
    const { handlers, heard } = setup(() => t);
    const target = el(button());
    handlers.click!({ target });
    expect(heard).toEqual(['ui-click']);
    uiSound('ui-confirm');
    t = performance.now() + 5;
    handlers.click!({ target });
    expect(heard).toEqual(['ui-click', 'ui-confirm']);
  });
  it('plays hover only for mouse pointers over data-sfx-hover', () => {
    const { handlers, heard, off } = setup(() => 0);
    const hov = el({ selectors: ['[data-sfx-hover]'], attrs: {} });
    handlers.pointerover!({ target: hov, pointerType: 'touch', relatedTarget: null });
    handlers.pointerover!({ target: el(button()), pointerType: 'mouse', relatedTarget: null });
    expect(heard).toEqual([]);
    handlers.pointerover!({ target: hov, pointerType: 'mouse', relatedTarget: null });
    expect(heard).toEqual(['ui-hover']);
    off();
    expect(Object.keys(handlers)).toEqual([]);
  });
});

describe('close/open pairing', () => {
  afterEach(() => {
    resetUiSound();
    vi.useRealTimers();
    sfxBus.clear();
  });
  it('drops a ui-close that is followed by a ui-open within the window', () => {
    vi.useFakeTimers();
    const heard: SfxId[] = [];
    sfxBus.on((e) => heard.push(e.id));
    uiSound('ui-close');
    vi.advanceTimersByTime(20);
    uiSound('ui-open');
    vi.advanceTimersByTime(500);
    expect(heard).toEqual(['ui-open']);
  });
  it('drops a pending ui-close when ui-back or ui-confirm follows', () => {
    vi.useFakeTimers();
    const heard: SfxId[] = [];
    sfxBus.on((e) => heard.push(e.id));
    uiSound('ui-back');
    uiSound('ui-close');
    vi.advanceTimersByTime(20);
    uiSound('ui-confirm');
    vi.advanceTimersByTime(500);
    uiSound('ui-close');
    uiSound('ui-back');
    vi.advanceTimersByTime(500);
    expect(heard).toEqual(['ui-back', 'ui-confirm', 'ui-back']);
  });
  it('plays a lone ui-close after the window, and drops a ui-close right after a ui-open', () => {
    vi.useFakeTimers();
    const heard: SfxId[] = [];
    sfxBus.on((e) => heard.push(e.id));
    uiSound('ui-close');
    uiSound('ui-close');
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(CLOSE_OPEN_WINDOW_MS + 1);
    expect(heard).toEqual(['ui-close']);
    uiSound('ui-open');
    vi.advanceTimersByTime(10);
    uiSound('ui-close');
    vi.advanceTimersByTime(500);
    expect(heard).toEqual(['ui-close', 'ui-open']);
  });
});

describe('insideTopModal', () => {
  const node = (inside: Node[] = []) => ({ contains: (n: Node) => inside.includes(n) });
  const target = {} as Node;
  it('allows everything without modals and only the top-most modal otherwise', () => {
    expect(insideTopModal({}, target)).toBe(true);
    expect(insideTopModal({ querySelectorAll: (() => []) as never }, target)).toBe(true);
    const under = node([target]);
    const top = node();
    expect(insideTopModal({ querySelectorAll: (() => [under, top]) as never }, target)).toBe(false);
    expect(insideTopModal({ querySelectorAll: (() => [top, under]) as never }, target)).toBe(true);
  });
  it('mutes hover under a modal backdrop', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const modal = node();
    const doc = { addEventListener: (n: string, h: (e: unknown) => void) => void (handlers[n] = h), removeEventListener: () => {}, querySelectorAll: () => [modal] };
    const heard: SfxId[] = [];
    sfxBus.on((e) => heard.push(e.id));
    installUiSoundDelegate(doc as never, () => 0);
    const hov = { ...el({ selectors: ['[data-sfx-hover]'], attrs: {} }), contains: () => false };
    handlers.pointerover!({ target: hov, pointerType: 'mouse', relatedTarget: null });
    expect(heard).toEqual([]);
  });
});
