import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadDotEnv, resolveConfigFile } from '../load-config.js';

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

/** N2: desktop mode (OFFICE_NO_DOTENV=1) must not read `.env` / `office.yaml` from cwd-relative paths. */
describe('N2: OFFICE_NO_DOTENV', () => {
  const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'tagconn-nodotenv-'));
  const plant = (cwd: string) => {
    mkdirSync(join(cwd, 'config'));
    writeFileSync(join(cwd, 'config', 'office.yaml'), 'server:\n  port: 9999\n');
    writeFileSync(join(cwd, '.env'), 'TAGCONN_TEST_PLANTED=yes\n');
  };
  afterEach(() => {
    delete process.env.TAGCONN_TEST_PLANTED;
  });

  it('loads the cwd .env and config/office.yaml by default (the dev behaviour)', () => {
    const cwd = tmp();
    plant(cwd);
    expect(loadDotEnv({}, cwd)).toBe(join(cwd, '.env'));
    expect(process.env.TAGCONN_TEST_PLANTED).toBe('yes');
    expect(resolveConfigFile({ env: {}, cwd })).toBe(join(cwd, 'config', 'office.yaml'));
  });

  it('with the switch set, neither the cwd .env nor the cwd office.yaml is loaded', () => {
    const cwd = tmp();
    plant(cwd);
    const env = { OFFICE_NO_DOTENV: '1' };
    expect(loadDotEnv(env, cwd)).toBeUndefined();
    expect(process.env.TAGCONN_TEST_PLANTED).toBeUndefined();
    expect(resolveConfigFile({ env, cwd })).toBeUndefined();
    expect(loadConfig({ env, cwd }).base.server.port).not.toBe(9999);
  });

  it('still reads an explicit OFFICE_CONFIG file, and OFFICE_CONFIG=none loads no file', () => {
    const cwd = tmp();
    plant(cwd);
    const owned = join(tmp(), 'office.yaml');
    writeFileSync(owned, 'server:\n  logLevel: warn\n');
    expect(loadConfig({ env: { OFFICE_NO_DOTENV: '1', OFFICE_CONFIG: owned }, cwd }).base.server.logLevel).toBe('warn');
    expect(resolveConfigFile({ env: { OFFICE_CONFIG: 'none' }, cwd })).toBeUndefined();
    expect(resolveConfigFile({ env: { OFFICE_NO_DOTENV: '1', OFFICE_CONFIG: 'none' }, cwd })).toBeUndefined();
  });
});
