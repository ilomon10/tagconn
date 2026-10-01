import { afterEach, describe, expect, it } from 'vitest';
import { sfxBus, type SfxId } from '../../../game/sfxBus';
import { clickSoundFor, installUiSoundDelegate, selectionSound, uiSound } from '../uiSound';

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
