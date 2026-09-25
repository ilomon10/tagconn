import { describe, expect, it } from 'vitest';
import { loadConfig } from '../load-config.js';

/** L3 (docs/design/runner-and-helpdesk.md): a non-empty `runner.token` that doesn't match
 * `RUNNER_TOKEN_RE` must fail loudly at boot, not surface later as an opaque handshake failure. */
describe('loadConfig: L3 boot validation of runner.token', () => {
  it('accepts an empty token (runner stays disabled)', () => {
    expect(() => loadConfig({ configFile: false, env: {}, overrides: { runner: { token: '' } } })).not.toThrow();
  });

  it('accepts a well-formed hex token', () => {
    const { base } = loadConfig({ configFile: false, env: {}, overrides: { runner: { token: 'a'.repeat(40) } } });
    expect(base.runner.token).toBe('a'.repeat(40));
  });

  it('rejects a non-empty token that does not match RUNNER_TOKEN_RE, with a clear error', () => {
    expect(() => loadConfig({ configFile: false, env: {}, overrides: { runner: { token: 'not-hex-at-all' } } })).toThrow(
      /runner\.token does not match/,
    );
    expect(() => loadConfig({ configFile: false, env: {}, overrides: { runner: { token: 'a'.repeat(31) } } })).toThrow(
      /runner\.token does not match/,
    ); // too short (min 32)
    expect(() => loadConfig({ configFile: false, env: {}, overrides: { runner: { token: 'A'.repeat(40) } } })).toThrow(
      /runner\.token does not match/,
    ); // uppercase hex is not accepted (lowercase only)
  });
});
