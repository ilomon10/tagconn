import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadRunnerConfig, parseCliArgs } from '../../src/config.js';
import { mkSandbox, rmSandbox } from '../helpers.js';

function writeConfig(dir: string, overrides: Record<string, unknown> = {}) {
  const path = join(dir, 'runner.json');
  writeFileSync(path, JSON.stringify({ token: 'a'.repeat(32), ...overrides }), { mode: 0o600 });
  return path;
}

describe('parseCliArgs', () => {
  it('parses --config <path>', () => {
    expect(parseCliArgs(['--config', '/tmp/runner.json'])).toEqual({ configPath: '/tmp/runner.json' });
  });

  it('parses --config=<path>', () => {
    expect(parseCliArgs(['--config=/tmp/runner.json'])).toEqual({ configPath: '/tmp/runner.json' });
  });

  it('throws a usage error without --config', () => {
    expect(() => parseCliArgs([])).toThrow(ConfigError);
  });
});

describe('loadRunnerConfig', () => {
  const sandboxes: string[] = [];
  afterEach(() => {
    for (const s of sandboxes.splice(0)) rmSandbox(s);
  });

  it('loads and validates a well-formed 0600 config', () => {
    const dir = mkSandbox();
    sandboxes.push(dir);
    const path = writeConfig(dir);
    const cfg = loadRunnerConfig(path);
    expect(cfg.token).toBe('a'.repeat(32));
    expect(cfg.runnerId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses a config that is not exactly mode 0600', () => {
    const dir = mkSandbox();
    sandboxes.push(dir);
    const path = writeConfig(dir);
    chmodSync(path, 0o644);
    expect(() => loadRunnerConfig(path)).toThrow(ConfigError);
  });

  it('refuses a missing config file', () => {
    expect(() => loadRunnerConfig('/definitely/not/here/runner.json')).toThrow(ConfigError);
  });

  it('refuses invalid JSON', () => {
    const dir = mkSandbox();
    sandboxes.push(dir);
    const path = join(dir, 'runner.json');
    writeFileSync(path, 'not json', { mode: 0o600 });
    expect(() => loadRunnerConfig(path)).toThrow(ConfigError);
  });

  it('refuses a config that fails schema validation (bad token shape)', () => {
    const dir = mkSandbox();
    sandboxes.push(dir);
    const path = join(dir, 'runner.json');
    writeFileSync(path, JSON.stringify({ token: 'not-hex!' }), { mode: 0o600 });
    expect(() => loadRunnerConfig(path)).toThrow(ConfigError);
  });

  it('generates and persists a runnerId on first load, then reuses it on the next load', () => {
    const dir = mkSandbox();
    sandboxes.push(dir);
    const path = writeConfig(dir);
    const first = loadRunnerConfig(path);
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    expect(onDisk.runnerId).toBe(first.runnerId);

    const second = loadRunnerConfig(path);
    expect(second.runnerId).toBe(first.runnerId);
  });

  it('realpaths allowedProjectDirs and trustOverrideDirs', () => {
    const dir = mkSandbox();
    sandboxes.push(dir);
    const project = join(dir, 'proj');
    mkdirSync(project, { recursive: true });
    const path = writeConfig(dir, { allowedProjectDirs: [project], trustOverrideDirs: [project] });
    const cfg = loadRunnerConfig(path);
    expect(cfg.allowedProjectDirs).toEqual([project]);
    expect(cfg.trustOverrideDirs).toEqual([project]);
  });

  it('applies a default stateDir when none is given', () => {
    const dir = mkSandbox();
    sandboxes.push(dir);
    const path = writeConfig(dir);
    const cfg = loadRunnerConfig(path);
    expect(cfg.stateDir.length).toBeGreaterThan(0);
  });
});
