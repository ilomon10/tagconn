import { describe, expect, it } from 'vitest';
import { isValidRoleName, isValidToken, validateNoSingleQuote, validateUrl } from '../install.ts';

describe('validateUrl', () => {
  it('accepts http and https URLs, stripping a trailing slash', () => {
    expect(validateUrl('http://127.0.0.1:4317')).toBe('http://127.0.0.1:4317');
    expect(validateUrl('https://example.com/')).toBe('https://example.com');
    expect(validateUrl('http://example.com///')).toBe('http://example.com');
  });

  it('rejects a non-http(s) protocol', () => {
    expect(() => validateUrl('ftp://example.com')).toThrow(/http or https/);
  });

  it('rejects an unparseable URL', () => {
    expect(() => validateUrl('not-a-url')).toThrow(/not a valid URL/);
  });

  it('rejects whitespace or quotes (would break the curl.conf/hook command quoting)', () => {
    expect(() => validateUrl('http://example.com/ x')).toThrow(/whitespace or quotes/);
    expect(() => validateUrl(`http://example.com/"x`)).toThrow(/whitespace or quotes/);
    expect(() => validateUrl(`http://example.com/'x`)).toThrow(/whitespace or quotes/);
  });
});

describe('validateNoSingleQuote', () => {
  it('passes a path with no single quote', () => {
    expect(() => validateNoSingleQuote('/tmp/sandbox/.config/tagconn', '--config-dir')).not.toThrow();
  });

  it('rejects a path containing a single quote (breaks out of the hook command quoting)', () => {
    expect(() => validateNoSingleQuote(`/tmp/it's-a-dir`, '--config-dir')).toThrow(/single quote/);
  });
});

describe('isValidToken', () => {
  it('accepts 16-128 lowercase hex chars', () => {
    expect(isValidToken('a'.repeat(16))).toBe(true);
    expect(isValidToken('0123456789abcdef')).toBe(true);
    expect(isValidToken('f'.repeat(128))).toBe(true);
  });

  it('rejects too-short, too-long, uppercase, or non-hex tokens', () => {
    expect(isValidToken('a'.repeat(15))).toBe(false);
    expect(isValidToken('f'.repeat(129))).toBe(false);
    expect(isValidToken('A'.repeat(16))).toBe(false);
    expect(isValidToken('not-hex-at-all!!')).toBe(false);
    expect(isValidToken('')).toBe(false);
  });
});

describe('isValidRoleName', () => {
  it('accepts a lowercase slug starting with a letter', () => {
    expect(isValidRoleName('developer')).toBe(true);
    expect(isValidRoleName('qa-engineer')).toBe(true);
    expect(isValidRoleName('a1')).toBe(true);
  });

  it('rejects names that are too short, start with a digit/dash, contain uppercase, or use path characters', () => {
    expect(isValidRoleName('a')).toBe(false);
    expect(isValidRoleName('1developer')).toBe(false);
    expect(isValidRoleName('-developer')).toBe(false);
    expect(isValidRoleName('Developer')).toBe(false);
    expect(isValidRoleName('../../etc/passwd')).toBe(false);
    expect(isValidRoleName('dev/eloper')).toBe(false);
  });
});
