import { describe, expect, it } from 'vitest';
import { resolveConfigDir, resolveSetupPaths } from '../src/index.ts';

describe('resolveSetupPaths', () => {
  it('uses XDG dirs on linux when set', () => {
    const p = resolveSetupPaths({
      platform: 'linux',
      homedir: '/home/u',
      env: { XDG_CONFIG_HOME: '/x/cfg', XDG_STATE_HOME: '/x/state', XDG_DATA_HOME: '/x/data' },
    });
    expect(p).toEqual({ config: '/x/cfg/tagconn', state: '/x/state/tagconn', data: '/x/data/tagconn', claudeDir: '/home/u/.claude' });
  });

  it('falls back to ~/.config, ~/.local/state and ~/.local/share', () => {
    const p = resolveSetupPaths({ platform: 'linux', homedir: '/home/u', env: {} });
    expect(p.config).toBe('/home/u/.config/tagconn');
    expect(p.state).toBe('/home/u/.local/state/tagconn');
    expect(p.data).toBe('/home/u/.local/share/tagconn');
  });

  it('legacyPosixConfig ignores XDG_CONFIG_HOME (where office-hook.sh looks) but keeps state/data XDG', () => {
    const p = resolveSetupPaths({
      platform: 'linux',
      homedir: '/home/u',
      env: { XDG_CONFIG_HOME: '/x/cfg', XDG_STATE_HOME: '/x/state' },
      legacyPosixConfig: true,
    });
    expect(p.config).toBe('/home/u/.config/tagconn');
    expect(p.state).toBe('/x/state/tagconn');
  });

  it('uses %APPDATA% / %LOCALAPPDATA% on win32', () => {
    const p = resolveSetupPaths({
      platform: 'win32',
      homedir: 'C:\\Users\\u',
      env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
    });
    expect(p.config).toBe('C:\\Users\\u\\AppData\\Roaming\\tagconn');
    expect(p.state).toBe('C:\\Users\\u\\AppData\\Local\\tagconn\\state');
    expect(p.data).toBe('C:\\Users\\u\\AppData\\Local\\tagconn\\data');
    expect(p.claudeDir).toBe('C:\\Users\\u\\.claude');
  });

  it('derives the win32 defaults from the home dir when APPDATA is unset', () => {
    const p = resolveSetupPaths({ platform: 'win32', homedir: 'C:\\Users\\u', env: {} });
    expect(p.config).toBe('C:\\Users\\u\\AppData\\Roaming\\tagconn');
    expect(p.data).toBe('C:\\Users\\u\\AppData\\Local\\tagconn\\data');
  });

  it('CLAUDE_CONFIG_DIR overrides the claude dir', () => {
    expect(resolveSetupPaths({ platform: 'linux', homedir: '/h', env: { CLAUDE_CONFIG_DIR: '/tmp/sb/.claude' } }).claudeDir).toBe('/tmp/sb/.claude');
  });
});

describe('resolveConfigDir', () => {
  const base = { platform: 'linux' as const, homedir: '/home/u', env: {} };
  it('flag > env > derived from a non-default claude dir > default', () => {
    const inputs = { configDirFlag: undefined, configDirEnv: undefined, claudeDirExplicit: false, claudeDir: '/home/u/.claude' };
    expect(resolveConfigDir(inputs, base)).toBe('/home/u/.config/tagconn');
    expect(resolveConfigDir({ ...inputs, configDirEnv: '/e' }, base)).toBe('/e');
    expect(resolveConfigDir({ ...inputs, configDirEnv: '/e', configDirFlag: '/f' }, base)).toBe('/f');
    expect(resolveConfigDir({ ...inputs, claudeDirExplicit: true, claudeDir: '/tmp/sb/.claude' }, base)).toBe('/tmp/sb/.config/tagconn');
    expect(resolveConfigDir({ ...inputs, claudeDirExplicit: true }, base)).toBe('/home/u/.config/tagconn');
  });

  it('defaults to %APPDATA%\\tagconn on win32', () => {
    const dir = resolveConfigDir(
      { configDirFlag: undefined, configDirEnv: undefined, claudeDirExplicit: false, claudeDir: 'C:\\Users\\u\\.claude' },
      { platform: 'win32', homedir: 'C:\\Users\\u', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } },
    );
    expect(dir).toBe('C:\\Users\\u\\AppData\\Roaming\\tagconn');
  });
});
