// M13 gate: untrusted strings (hero names, agent descriptions, tool names, hook messages) shown in the
// name plates and the alert box. Strips control and bidi-override characters (they can reverse or
// break the line layout) and clips by code point so a huge description never reaches layout code.

// C0/C1 controls, plus the bidi embedding/override/isolate controls U+202A..U+202E and U+2066..U+2069.
const UNSAFE = /[\p{Cc}‪-‮⁦-⁩]+/gu;

/** `text` with control/bidi characters replaced by one space, whitespace collapsed and trimmed. */
export function sanitizeDisplayText(text: string): string {
  return text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
}

/** Sanitized `text`, cut to at most `max` code points (the last one becomes `…` when cut). */
export function clipDisplayText(text: string | null | undefined, max: number): string {
  if (!text || max <= 0) return '';
  // Pre-cut so a megabyte string is never fully scanned (a code point is at most 2 UTF-16 units).
  const head = text.length > max * 2 + 64 ? text.slice(0, max * 2 + 64) : text;
  const chars = Array.from(sanitizeDisplayText(head));
  if (chars.length <= max && head === text) return chars.join('');
  return `${chars.slice(0, max - 1).join('')}…`;
}
