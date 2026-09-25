import { type ActivityRule, DEFAULT_ACTIVITY_RULES } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { mapRule } from '../activity.service.js';

describe('mapRule (default rules)', () => {
  const map = (tool: string, input: unknown = {}) => mapRule(tool, input, DEFAULT_ACTIVITY_RULES);

  it('maps Agent calls to delegating in the meeting room', () => {
    expect(map('Agent', { description: 'list files' })).toEqual({
      activity: 'delegating',
      zone: 'meeting-room',
      bubble: 'Delegating: list files',
    });
  });

  it('uses input regexes to tell test runs from other shell commands', () => {
    expect(map('Bash', { command: 'pnpm vitest run' })).toMatchObject({ activity: 'testing', zone: 'qa-lab' });
    expect(map('Bash', { command: 'git diff HEAD~1' })).toMatchObject({ activity: 'reading', zone: 'review-booth' });
    const plain = map('Bash', { command: 'ls -la' });
    expect(plain).toEqual({ activity: 'running', zone: undefined, bubble: '$ ls -la' });
  });

  it('truncates long commands to 40 chars', () => {
    const cmd = 'echo ' + 'x'.repeat(100);
    expect(map('Bash', { command: cmd }).bubble).toBe(`$ ${cmd.slice(0, 40)}…`);
  });

  it('renders {file} as a basename and leaves the zone to the role when the rule has none', () => {
    expect(map('Read', { file_path: '/a/b/auth.ts' })).toEqual({ activity: 'reading', zone: undefined, bubble: 'Reading auth.ts' });
    expect(map('Edit', { file_path: '/a/b/c.ts' })).toMatchObject({ activity: 'typing', zone: 'desks', bubble: 'Editing c.ts' });
    expect(map('NotebookEdit', { notebook_path: '/n/x.ipynb' }).bubble).toBe('Editing x.ipynb');
  });

  it('anchors tool regexes', () => {
    expect(map('Grep', { pattern: 'TODO' })).toMatchObject({ activity: 'searching', bubble: 'Searching TODO' });
    // "ReadMcpResource" must not match the anchored "Read" rule
    expect(map('ReadMcpResource')).toEqual({ activity: 'thinking', zone: undefined, bubble: 'ReadMcpResource' });
    expect(map('mcp__github__create_pr')).toMatchObject({ activity: 'running', bubble: 'mcp__github__create_pr' });
  });

  it('first match wins and missing vars render empty', () => {
    const rules: ActivityRule[] = [
      { tool: 'Foo', activity: 'meeting', bubble: 'Foo on {file}' },
      { tool: 'Foo', activity: 'typing' },
    ];
    expect(mapRule('Foo', {}, rules)).toEqual({ activity: 'meeting', zone: undefined, bubble: 'Foo on' });
    expect(mapRule('Bar', {}, rules)).toEqual({ activity: 'thinking', bubble: 'Bar' });
  });
});
