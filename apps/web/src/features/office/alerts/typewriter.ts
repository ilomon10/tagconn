/** The first N code points of `chars`, N = elapsed * rate (never splits a surrogate pair). Reduced motion: all of it.
 *  Pass `Array.from(text)` computed once (useMemo), not per tick. */
export function typewriterText(chars: readonly string[], elapsedMs: number, charsPerSec: number, reduced: boolean): string {
  if (reduced) return chars.join('');
  const n = Math.max(0, Math.floor((elapsedMs * charsPerSec) / 1000));
  return chars.slice(0, n).join('');
}

export function typewriterDone(chars: readonly string[], elapsedMs: number, charsPerSec: number, reduced: boolean): boolean {
  if (reduced) return true;
  return Math.max(0, Math.floor((elapsedMs * charsPerSec) / 1000)) >= chars.length;
}
