import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMarkdown } from './markdown';

// `renderMarkdown` returns React elements, not an HTML string — rendering to static markup (server
// side, no DOM needed) is the simplest way to assert on the actual output without a sanitizer of our
// own to double-check, and it exercises exactly what the browser would eventually produce.
const html = (src: string) => renderToStaticMarkup(renderMarkdown(src));

describe('renderMarkdown', () => {
  it('renders a simple paragraph', () => {
    expect(html('hello world')).toBe('<p class="md-p">hello world</p>');
  });

  it('joins soft-wrapped lines within a paragraph and splits on a blank line', () => {
    const out = html('line one\nline two\n\nsecond paragraph');
    expect(out).toContain('<p class="md-p">line one line two</p>');
    expect(out).toContain('<p class="md-p">second paragraph</p>');
  });

  it('renders a fenced code block as pre/code, preserving newlines', () => {
    const out = html('```ts\nconst x = 1;\nconsole.log(x);\n```');
    expect(out).toBe('<pre class="md-code-block"><code>const x = 1;\nconsole.log(x);</code></pre>');
  });

  it('renders inline code', () => {
    expect(html('run `pnpm test` now')).toBe('<p class="md-p">run <code class="md-inline-code">pnpm test</code> now</p>');
  });

  it('renders bold and italic (both marker styles)', () => {
    expect(html('**bold** and __also bold__')).toBe('<p class="md-p"><strong>bold</strong> and <strong>also bold</strong></p>');
    expect(html('*italic* and _also italic_')).toBe('<p class="md-p"><em>italic</em> and <em>also italic</em></p>');
  });

  it('renders an unordered list', () => {
    const out = html('- one\n- two\n* three');
    expect(out).toBe('<ul class="md-list"><li>one</li><li>two</li><li>three</li></ul>');
  });

  it('renders an ordered list', () => {
    const out = html('1. first\n2. second');
    expect(out).toBe('<ol class="md-list"><li>first</li><li>second</li></ol>');
  });

  it('renders a safe http(s) link with noopener/noreferrer and a new tab', () => {
    const out = html('see [the docs](https://example.com/docs) for more');
    expect(out).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">the docs</a>');
  });

  it('drops a javascript: link entirely, keeping only the label as text', () => {
    const out = html('click [here](javascript:alert(1)) now');
    expect(out).not.toContain('<a');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('here');
  });

  it('drops other unsafe schemes (data:, vbscript:) the same way', () => {
    for (const url of ['data:text/html;base64,abc', 'vbscript:msgbox(1)', '//evil.example.com/x']) {
      const out = html(`[label](${url})`);
      expect(out).not.toContain('<a');
      expect(out).not.toContain(url);
    }
  });

  it('drops images entirely, leaking neither the alt text nor the src', () => {
    const out = html('before ![a secret alt](https://evil.example.com/track.png) after');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('evil.example.com');
    expect(out).not.toContain('a secret alt');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('escapes raw HTML in the source instead of rendering it', () => {
    const out = html('<script>alert(1)</script> and <b>not bold</b>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('&lt;b&gt;not bold&lt;/b&gt;');
  });

  it('does not choke on empty input', () => {
    expect(html('')).toBe('');
  });
});
