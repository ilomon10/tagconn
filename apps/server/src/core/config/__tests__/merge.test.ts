import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandHome } from '../merge.js';

describe('expandHome', () => {
  it('expands a lone ~, ~/ and ~\\ (Windows separator)', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/.claude')).toBe(join(homedir(), '.claude'));
    expect(expandHome('~\\.claude\\projects')).toBe(join(homedir(), '.claude\\projects'));
  });

  it('leaves other paths (including ~user and a mid-path ~) alone', () => {
    for (const p of ['/abs/~/x', '~user/x', 'C:\\Users\\x', 'rel/~']) expect(expandHome(p)).toBe(p);
  });
});
