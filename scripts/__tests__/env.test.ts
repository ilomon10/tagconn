import { describe, expect, it } from 'vitest';
import { parseEnvFile, upsertEnvLine } from '../install.ts';

describe('parseEnvFile', () => {
  it('parses KEY=value lines, ignoring comments and blank lines', () => {
    const text = ['# a comment', '', 'OFFICE_HOOK_TOKEN=abc123', 'OFFICE_PORT=4317', ''].join('\n');
    const map = parseEnvFile(text);
    expect(map.get('OFFICE_HOOK_TOKEN')).toBe('abc123');
    expect(map.get('OFFICE_PORT')).toBe('4317');
    expect(map.size).toBe(2);
  });

  it('strips a wrapping double or single quote from the value', () => {
    const map = parseEnvFile(['KEY_A="quoted value"', "KEY_B='also quoted'"].join('\n'));
    expect(map.get('KEY_A')).toBe('quoted value');
    expect(map.get('KEY_B')).toBe('also quoted');
  });

  it('ignores a line with no "="', () => {
    const map = parseEnvFile('not-a-valid-line\nKEY=value');
    expect(map.size).toBe(1);
    expect(map.get('KEY')).toBe('value');
  });
});

describe('upsertEnvLine', () => {
  it('appends a new key that is not present', () => {
    const lines = upsertEnvLine(['A=1'], 'B', '2');
    expect(lines).toEqual(['A=1', 'B=2']);
  });

  it('replaces an existing key in place, keeping line order', () => {
    const lines = upsertEnvLine(['A=1', 'B=old', 'C=3'], 'B', 'new');
    expect(lines).toEqual(['A=1', 'B=new', 'C=3']);
  });
});
