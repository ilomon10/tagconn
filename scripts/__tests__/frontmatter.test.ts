import { describe, expect, it } from 'vitest';
import { buildAgentFile, parseFrontmatter } from '../install.ts';

describe('parseFrontmatter', () => {
  it('parses double-quoted and single-quoted values, stripping the quotes', () => {
    const text = ['---', 'name: developer', 'description: "Does things: carefully"', "model: 'sonnet'", '---', 'Body text.', ''].join(
      '\n',
    );
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({
      name: 'developer',
      description: 'Does things: carefully',
      model: 'sonnet',
    });
    expect(body).toBe('Body text.\n');
  });

  it('keeps office-* keys in the parsed frontmatter (stripping happens later, in buildAgentFile)', () => {
    const text = ['---', 'name: analyst', 'office-title: Business Analyst', 'office-enabled: false', '---', 'Body.'].join('\n');
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter['office-title']).toBe('Business Analyst');
    expect(frontmatter['office-enabled']).toBe('false');
  });

  it('ignores blank lines and comment lines inside the frontmatter block', () => {
    const text = ['---', '# a comment', '', 'name: qa-engineer', '---', 'Body.'].join('\n');
    const { frontmatter } = parseFrontmatter(text);
    expect(frontmatter).toEqual({ name: 'qa-engineer' });
  });

  it('returns an empty frontmatter and the whole text as body when there is no --- fence', () => {
    const text = 'Just a plain file, no frontmatter.\n';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({});
    expect(body).toBe(text);
  });

  it('returns an empty frontmatter when the closing --- is missing', () => {
    const text = '---\nname: broken\nno closing fence here';
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter).toEqual({});
    expect(body).toBe(text);
  });
});

describe('buildAgentFile', () => {
  it('keeps only name/description/tools/model and drops office-* keys', () => {
    const out = buildAgentFile(
      {
        name: 'developer',
        description: 'Implements features.',
        tools: 'Read, Write',
        model: 'sonnet',
        'office-title': 'Developer',
        'office-zone': 'desk',
        'office-color': '#fff',
        'office-sprite': '3',
      },
      'You are a developer.\n',
    );
    expect(out).toContain('name: developer');
    expect(out).toContain('tools: Read, Write');
    expect(out).toContain('model: sonnet');
    expect(out).not.toContain('office-');
  });

  it('appends the managed-by marker', () => {
    const out = buildAgentFile({ name: 'developer' }, 'Body.\n');
    expect(out).toMatch(/<!-- managed-by: tagconn -->\n$/);
  });

  it('re-quotes a description containing a colon, and preserves an already-quoted value', () => {
    const out = buildAgentFile(
      { name: 'developer', description: 'Use PROACTIVELY: for scoped tasks' },
      'Body.',
    );
    expect(out).toContain('description: "Use PROACTIVELY: for scoped tasks"');
  });

  it('does not double-quote a value that already starts with a quote', () => {
    const out = buildAgentFile({ name: 'developer', description: '"already: quoted"' }, 'Body.');
    expect(out).toContain('description: "already: quoted"');
    expect(out).not.toContain('description: ""already');
  });

  it('trims trailing whitespace from the body before the marker', () => {
    const out = buildAgentFile({ name: 'developer' }, 'Body.\n\n\n   ');
    expect(out).toBe('---\nname: developer\n---\nBody.\n\n<!-- managed-by: tagconn -->\n');
  });
});
