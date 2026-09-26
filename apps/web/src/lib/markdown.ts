import { createElement, Fragment, type ReactNode } from 'react';

/**
 * Minimal SAFE markdown renderer for quest and Receptionist transcripts (docs/design/
 * runner-and-helpdesk.md §3 "Markdown", §4.1). The model's output is untrusted text, so this file
 * never touches `dangerouslySetInnerHTML` and never parses raw HTML tags — every run of plain text
 * becomes a React string child, which React escapes on its own, so "escaping" falls out of using
 * `createElement` instead of building an HTML string.
 *
 * Supported: paragraphs, fenced code blocks, inline code, **bold** or __bold__, *italic* or _italic_,
 * unordered (`-`/`*`/`+`) and ordered (`1.`) lists, and links — but ONLY `http(s):` ones, rendered
 * with `rel="noopener noreferrer" target="_blank"` (never `rel=opener`, which would hand the linked
 * page a `window.opener` back into this app). Anything else (`javascript:`, `data:`, `vbscript:`,
 * bare `mailto:`, ...) has its link markup dropped — the label still renders as plain text, but never
 * as a clickable link with an unsafe href. Images (`![alt](src)`) are dropped entirely: there is no
 * legitimate reason for a transcript bubble to load a remote, potentially tracking or spoofed image.
 */

let renderSeq = 0;

function isSafeHttpUrl(url: string): boolean {
  // Reject control characters up front (e.g. an embedded newline/tab that could smuggle a scheme past
  // a naive check) before handing the string to `URL`.
  if (/[\u0000-\u001f]/.test(url)) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * One pass over inline markup within a single line/paragraph of already-block-level text. Order in
 * the alternation matters only where two branches could start at the same character (`![` vs `[`,
 * and `**`/`__` vs `*`/`_`) — the leftmost-starting, first-listed alternative wins there, which is
 * exactly why images precede links and `**`/`__` precede `*`/`_` below.
 */
const INLINE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)|\[([^\]]*)\]\(([^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_/g;

function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let idx = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text))) {
    if (m.index > lastIndex) nodes.push(text.slice(lastIndex, m.index));
    const [, , imgSrc, linkText, linkHref, code, boldA, boldB, italA, italB] = m;
    if (imgSrc !== undefined) {
      // Image: dropped entirely, including its alt text — nothing pushed for this match.
    } else if (linkHref !== undefined) {
      const label = linkText ?? '';
      if (isSafeHttpUrl(linkHref)) {
        nodes.push(
          createElement('a', { key: `${keyPrefix}-${idx++}`, href: linkHref, target: '_blank', rel: 'noopener noreferrer' }, label),
        );
      } else {
        // Unsafe scheme: drop the link markup and href, keep only the visible label as plain text.
        nodes.push(label);
      }
    } else if (code !== undefined) {
      nodes.push(createElement('code', { key: `${keyPrefix}-${idx++}`, className: 'md-inline-code' }, code));
    } else if (boldA !== undefined || boldB !== undefined) {
      nodes.push(createElement('strong', { key: `${keyPrefix}-${idx++}` }, boldA ?? boldB));
    } else if (italA !== undefined || italB !== undefined) {
      nodes.push(createElement('em', { key: `${keyPrefix}-${idx++}` }, italA ?? italB));
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

const UL_RE = /^[-*+]\s+(.*)$/;
const OL_RE = /^\d+\.\s+(.*)$/;
const FENCE_RE = /^```(\w*)\s*$/;

/** Renders a block of markdown text to a tree of plain React elements. Safe to call with arbitrary,
 *  untrusted text — worst case it renders oddly, it never executes anything or leaks a raw HTML sink. */
export function renderMarkdown(source: string): ReactNode {
  const runId = `md${(renderSeq++).toString(36)}`;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let blockKey = 0;
  const nextBlockKey = () => `${runId}-${blockKey++}`;

  let paraBuf: string[] = [];
  const flushParagraph = () => {
    if (paraBuf.length === 0) return;
    const key = nextBlockKey();
    blocks.push(createElement('p', { key, className: 'md-p' }, ...parseInline(paraBuf.join(' '), key)));
    paraBuf = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushParagraph();
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        codeLines.push(lines[i] ?? '');
        i++;
      }
      i++; // consume the closing fence, if any (an unterminated block just runs to the end)
      blocks.push(
        createElement('pre', { key: nextBlockKey(), className: 'md-code-block' }, createElement('code', null, codeLines.join('\n'))),
      );
      continue;
    }

    const ulMatch = UL_RE.exec(line);
    const olMatch = OL_RE.exec(line);
    if (ulMatch || olMatch) {
      flushParagraph();
      const ordered = !ulMatch;
      const items: ReactNode[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        const m = ordered ? OL_RE.exec(l) : UL_RE.exec(l);
        if (!m) break;
        const itemKey = nextBlockKey();
        items.push(createElement('li', { key: itemKey }, ...parseInline(m[1] ?? '', itemKey)));
        i++;
      }
      blocks.push(createElement(ordered ? 'ol' : 'ul', { key: nextBlockKey(), className: 'md-list' }, ...items));
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      i++;
      continue;
    }

    paraBuf.push(line);
    i++;
  }
  flushParagraph();

  return createElement(Fragment, null, ...blocks);
}
