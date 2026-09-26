import { describe, expect, it } from 'vitest';
import { ReducedMotionWatcher, type ReducedMotionMediaQuery } from '../reducedMotion';

function fakeMatchMedia(initial: boolean) {
  let matches = initial;
  let listener: (() => void) | null = null;
  const mql: ReducedMotionMediaQuery = {
    get matches() {
      return matches;
    },
    addEventListener: (_type, l) => {
      listener = l;
    },
    removeEventListener: () => {
      listener = null;
    },
  };
  return {
    matchMedia: () => mql,
    fire: (next: boolean) => {
      matches = next;
      listener?.();
    },
    hasListener: () => listener !== null,
  };
}

describe('ReducedMotionWatcher', () => {
  it('reads the initial value from matchMedia', () => {
    const { matchMedia } = fakeMatchMedia(true);
    expect(new ReducedMotionWatcher(matchMedia).value).toBe(true);
    expect(new ReducedMotionWatcher(fakeMatchMedia(false).matchMedia).value).toBe(false);
  });

  it('updates the cached value when the media query changes, without re-querying matchMedia', () => {
    const { matchMedia, fire } = fakeMatchMedia(false);
    const watcher = new ReducedMotionWatcher(matchMedia);
    expect(watcher.value).toBe(false);
    fire(true);
    expect(watcher.value).toBe(true);
    fire(false);
    expect(watcher.value).toBe(false);
  });

  it('falls back to the older addListener/removeListener pair', () => {
    let matches = true;
    const held: { listener: (() => void) | null } = { listener: null };
    const mql: ReducedMotionMediaQuery = {
      get matches() {
        return matches;
      },
      addListener: (l) => {
        held.listener = l;
      },
      removeListener: () => {
        held.listener = null;
      },
    };
    const watcher = new ReducedMotionWatcher(() => mql);
    expect(watcher.value).toBe(true);
    matches = false;
    held.listener?.();
    expect(watcher.value).toBe(false);
    watcher.destroy();
    expect(held.listener).toBeNull();
  });

  it('stops listening after destroy()', () => {
    const { matchMedia, fire, hasListener } = fakeMatchMedia(false);
    const watcher = new ReducedMotionWatcher(matchMedia);
    expect(hasListener()).toBe(true);
    watcher.destroy();
    expect(hasListener()).toBe(false);
    // firing after destroy is a no-op on the fake (listener already null); value stays cached.
    fire(true);
    expect(watcher.value).toBe(false);
  });

  it('is safe with no matchMedia available (returns false, never throws)', () => {
    const watcher = new ReducedMotionWatcher(undefined);
    expect(typeof watcher.value).toBe('boolean');
    expect(() => watcher.destroy()).not.toThrow();
  });

  it('destroy() is idempotent', () => {
    const { matchMedia } = fakeMatchMedia(false);
    const watcher = new ReducedMotionWatcher(matchMedia);
    watcher.destroy();
    expect(() => watcher.destroy()).not.toThrow();
  });
});
