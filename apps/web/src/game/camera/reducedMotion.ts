/**
 * Caches "prefers-reduced-motion: reduce" and listens for changes, so a hot path like
 * `OfficeScene.update()`'s per-frame follow-camera lerp can read a plain boolean instead of
 * calling `matchMedia` on every tick (M9 8f deferred item). Wraps a `MediaQueryList` so the
 * caching/subscription logic is unit-testable without a real browser: pass a fake `matchMedia`
 * that returns an object shaped like one (`matches` plus either the modern `addEventListener`/
 * `removeEventListener` pair or the older Safari `addListener`/`removeListener`).
 *
 * `themes/fx.ts`'s `prefersReducedMotion()` stays the one-off check used everywhere else (theme
 * ambient FX, instant-vs-tween branches triggered by user actions); this watcher exists only for
 * per-frame reads.
 */
export interface ReducedMotionMediaQuery {
  matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
  /** Safari < 14 */
  addListener?(listener: () => void): void;
  removeListener?(listener: () => void): void;
}

export type MatchMediaFn = (query: string) => ReducedMotionMediaQuery;

function resolveMatchMedia(matchMedia?: MatchMediaFn): MatchMediaFn | null {
  if (matchMedia) return matchMedia;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return (query: string) => window.matchMedia(query);
}

export class ReducedMotionWatcher {
  private mql: ReducedMotionMediaQuery | null;
  private cached: boolean;
  private readonly onChange = () => {
    this.cached = this.mql?.matches ?? false;
  };

  constructor(matchMedia?: MatchMediaFn) {
    const mm = resolveMatchMedia(matchMedia);
    this.mql = mm ? mm('(prefers-reduced-motion: reduce)') : null;
    this.cached = this.mql?.matches ?? false;
    if (this.mql?.addEventListener) this.mql.addEventListener('change', this.onChange);
    else this.mql?.addListener?.(this.onChange);
  }

  /** Cheap per-frame read: no `matchMedia` call, just the last known value. */
  get value(): boolean {
    return this.cached;
  }

  /** Stop listening for changes. Safe to call more than once. */
  destroy() {
    if (this.mql?.removeEventListener) this.mql.removeEventListener('change', this.onChange);
    else this.mql?.removeListener?.(this.onChange);
    this.mql = null;
  }
}
