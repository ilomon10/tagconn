/** The first N code points of `text`, N = elapsed * rate (never splits a surrogate pair). Reduced motion: all of it. */
export function typewriterText(text: string, elapsedMs: number, charsPerSec: number, reduced: boolean): string {
  if (reduced) return text;
  const n = Math.max(0, Math.floor((elapsedMs * charsPerSec) / 1000));
  const chars = Array.from(text);
  return n >= chars.length ? text : chars.slice(0, n).join('');
}

export function typewriterDone(text: string, elapsedMs: number, charsPerSec: number, reduced: boolean): boolean {
  if (reduced) return true;
  return Math.max(0, Math.floor((elapsedMs * charsPerSec) / 1000)) >= Array.from(text).length;
}
