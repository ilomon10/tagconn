// M13 gate: untrusted strings (hero names, agent descriptions, tool names, hook messages) shown in the
// name plates and the alert box. Strips control and bidi-override characters (they can reverse or
// break the line layout) and clips by code point so a huge description never reaches layout code.

// C0/C1 controls plus every format character (zero-width, bidi marks/embeddings/overrides/isolates, ALM...),
// except U+200D ZWJ and the tag characters U+E0020..U+E007F, which emoji ZWJ sequences and subdivision flags need.
const UNSAFE = /(?:(?![\u200D\u{E0020}-\u{E007F}])[\p{Cc}\p{Cf}])+/gu;

/** `text` with control/bidi characters replaced by one space, whitespace collapsed and trimmed. */
export function sanitizeDisplayText(text: string): string {
  return text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
}

/** Sanitized `text`, cut to at most `max` code points (the last one becomes `…` when cut). */
export function clipDisplayText(text: string | null | undefined, max: number): string {
  if (!text || max <= 0) return '';
  // Pre-cut so a megabyte string is never fully scanned (a code point is at most 2 UTF-16 units).
  const cut = text.length > max * 2 + 64;
  let head = cut ? text.slice(0, max * 2 + 64) : text;
  // The pre-cut may split a surrogate pair; drop the orphaned high surrogate.
  if (cut && /[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  const chars = Array.from(sanitizeDisplayText(head));
  if (!chars.length) return '';
  if (chars.length <= max && !cut) return chars.join('');
  return `${chars.slice(0, max - 1).join('')}…`;
}
