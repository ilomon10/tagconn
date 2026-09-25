import { describe, expect, it } from 'vitest';
import { checkInitWatchdog, checkToolUseWatchdog } from '../../src/watchdog.js';

describe('checkInitWatchdog (L5)', () => {
  it('passes when init.tools exactly equals the --tools set (order-independent) and mcpServers is empty', () => {
    expect(checkInitWatchdog({ tools: ['Grep', 'Read', 'Glob'], mcpServers: [] }, ['Read', 'Grep', 'Glob'])).toBeUndefined();
  });

  it('flags a mismatch when the CLI reports MORE tools than requested (V1 exact-equality)', () => {
    const violation = checkInitWatchdog({ tools: ['Read', 'Grep', 'Glob', 'Bash'], mcpServers: [] }, ['Read', 'Grep', 'Glob']);
    expect(violation).toBeDefined();
  });

  it('flags a mismatch when the CLI reports FEWER tools than requested', () => {
    expect(checkInitWatchdog({ tools: ['Read'], mcpServers: [] }, ['Read', 'Grep'])).toBeDefined();
  });

  it('flags any non-empty mcpServers, even with a matching tool set', () => {
    expect(checkInitWatchdog({ tools: ['Read'], mcpServers: ['some-server'] }, ['Read'])).toBeDefined();
  });
});

describe('checkToolUseWatchdog', () => {
  it('passes a tool_use within the expected set', () => {
    expect(checkToolUseWatchdog('Read', ['Read', 'Grep'])).toBeUndefined();
  });

  it('flags a tool_use outside the expected set', () => {
    expect(checkToolUseWatchdog('Bash', ['Read', 'Grep'])).toBeDefined();
  });

  it('flags any mcp__* tool regardless of the expected set', () => {
    expect(checkToolUseWatchdog('mcp__filesystem__read', ['Read', 'mcp__filesystem__read'])).toBeDefined();
  });
});
