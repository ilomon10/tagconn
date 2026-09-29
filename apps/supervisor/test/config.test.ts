import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DESKTOP_CONFIG } from '@tagconn/shared';
import { writeSecretFile } from '@tagconn/setup';
import { ConfigStore, corsOriginsFor } from '../src/config.ts';
import { resolvePaths } from '../src/paths.ts';
import { tempDir } from './helpers.ts';

describe('ConfigStore', () => {
  it('returns the defaults when desktop.json does not exist, and persists a merge', () => {
    const dir = tempDir();
    const store = new ConfigStore({ configDir: dir });
    expect(store.get()).toEqual(DEFAULT_DESKTOP_CONFIG);
    store.set({ attributionReadme: true });
    expect(store.get()).toEqual({ ...DEFAULT_DESKTOP_CONFIG, attributionReadme: true });
    expect(JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8')).attributionReadme).toBe(true);
  });

  it('falls back to the defaults (and warns) on a corrupt or invalid file', () => {
    const dir = tempDir();
    const warnings: string[] = [];
    const store = new ConfigStore({ configDir: dir, warn: (m) => warnings.push(m) });
    writeFileSync(join(dir, 'desktop.json'), '{oops');
    expect(store.get()).toEqual(DEFAULT_DESKTOP_CONFIG);
    writeFileSync(join(dir, 'desktop.json'), JSON.stringify({ serverPort: 80 }));
    expect(store.get()).toEqual(DEFAULT_DESKTOP_CONFIG);
    expect(warnings).toHaveLength(2);
  });

  it('rejects an invalid patch without writing it', () => {
    const dir = tempDir();
    const store = new ConfigStore({ configDir: dir });
    expect(() => store.set({ serverPort: 22 })).toThrow();
    expect(existsSync(join(dir, 'desktop.json'))).toBe(false);
  });

  it('rewrites hook.json, runner.json and server-url together on a port change, keeping the secrets and modes', () => {
    const dir = tempDir();
    const token = 'a'.repeat(64);
    writeSecretFile(join(dir, 'hook.json'), JSON.stringify({ version: 1, url: 'http://127.0.0.1:4317', token: 'b'.repeat(32), attributionReadme: false }));
    writeSecretFile(join(dir, 'runner.json'), JSON.stringify({ url: 'http://127.0.0.1:4317', token, allowedProjectDirs: [], maxPermissionMode: 'plan' }));
    writeFileSync(join(dir, 'server-url'), 'http://127.0.0.1:4317\n');
    const store = new ConfigStore({ configDir: dir });
    store.set({ serverPort: 4522 });
    const hook = JSON.parse(readFileSync(join(dir, 'hook.json'), 'utf8'));
    const runner = JSON.parse(readFileSync(join(dir, 'runner.json'), 'utf8'));
    expect(hook).toMatchObject({ url: 'http://127.0.0.1:4522', token: 'b'.repeat(32), attributionReadme: false });
    expect(runner).toMatchObject({ url: 'http://127.0.0.1:4522', token, maxPermissionMode: 'plan' });
    expect(readFileSync(join(dir, 'server-url'), 'utf8')).toBe('http://127.0.0.1:4522\n');
    if (process.platform !== 'win32') expect(statSync(join(dir, 'runner.json')).mode & 0o777).toBe(0o600);
    // The server's origin allow-list follows the port (it is passed as env at every start).
    expect(corsOriginsFor(4522)).toEqual(['http://127.0.0.1:4522', 'http://localhost:4522']);
  });

  it('leaves a non-loopback runner url alone and mirrors allowed dirs into runner.json', () => {
    const dir = tempDir();
    writeSecretFile(join(dir, 'runner.json'), JSON.stringify({ url: 'http://office.lan:4317', token: 'c'.repeat(64), allowedProjectDirs: [] }));
    const store = new ConfigStore({ configDir: dir });
    store.set({ serverPort: 4523, allowedProjectDirs: ['/work/a'] });
    expect(JSON.parse(readFileSync(join(dir, 'runner.json'), 'utf8'))).toMatchObject({ url: 'http://office.lan:4317', allowedProjectDirs: ['/work/a'] });
  });

  it('does nothing to files that do not exist yet (before setup ran)', () => {
    const dir = tempDir();
    new ConfigStore({ configDir: dir }).set({ serverPort: 4524 });
    expect(existsSync(join(dir, 'hook.json'))).toBe(false);
  });
});

describe('resolvePaths', () => {
  it('honours XDG_* on POSIX (no legacyPosixConfig) and APPDATA/LOCALAPPDATA on win32', () => {
    const posix = resolvePaths({ XDG_CONFIG_HOME: '/x/cfg', XDG_STATE_HOME: '/x/state', XDG_DATA_HOME: '/x/data' }, 'linux');
    expect(posix).toMatchObject({ config: '/x/cfg/tagconn', state: '/x/state/tagconn', data: '/x/data/tagconn' });
    const win = resolvePaths({ APPDATA: 'C:\\U\\AppData\\Roaming', LOCALAPPDATA: 'C:\\U\\AppData\\Local' }, 'win32');
    expect(win).toMatchObject({ config: 'C:\\U\\AppData\\Roaming\\tagconn', state: 'C:\\U\\AppData\\Local\\tagconn\\state', data: 'C:\\U\\AppData\\Local\\tagconn\\data' });
  });

  it('TAGCONN_CONFIG_DIR overrides the config dir', () => {
    expect(resolvePaths({ TAGCONN_CONFIG_DIR: '/sandbox/cfg' }, 'linux').config).toBe('/sandbox/cfg');
  });
});
