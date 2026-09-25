import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfigDir as resolveConfigDirDoctor } from '../doctor.ts';
import { resolveConfigDir as resolveConfigDirInstall } from '../install.ts';

const DEFAULT_CONFIG_DIR = join(homedir(), '.config', 'tagconn');
const DEFAULT_CLAUDE_DIR = join(homedir(), '.claude');

// install.ts and doctor.ts each carry their own copy of this precedence
// logic (see the "Same resolution as scripts/install.ts" comment in
// doctor.ts) - run every case against both to keep them in lockstep.
describe.each([
  ['install.ts', resolveConfigDirInstall],
  ['doctor.ts', resolveConfigDirDoctor],
])('resolveConfigDir (%s)', (_name, resolveConfigDir) => {
  it('defaults to ~/.config/tagconn when nothing else is set', () => {
    const dir = resolveConfigDir({
      configDirFlag: undefined,
      configDirEnv: undefined,
      claudeDirExplicit: false,
      claudeDir: DEFAULT_CLAUDE_DIR,
    });
    expect(dir).toBe(DEFAULT_CONFIG_DIR);
  });

  it('derives from a non-default --claude-dir when explicit and no flag/env override', () => {
    const dir = resolveConfigDir({
      configDirFlag: undefined,
      configDirEnv: undefined,
      claudeDirExplicit: true,
      claudeDir: '/tmp/sandbox/.claude',
    });
    expect(dir).toBe('/tmp/sandbox/.config/tagconn');
  });

  it('falls back to the default when --claude-dir is explicit but equals the real default', () => {
    const dir = resolveConfigDir({
      configDirFlag: undefined,
      configDirEnv: undefined,
      claudeDirExplicit: true,
      claudeDir: DEFAULT_CLAUDE_DIR,
    });
    expect(dir).toBe(DEFAULT_CONFIG_DIR);
  });

  it('TAGCONN_CONFIG_DIR env overrides a derived-from-claude-dir result', () => {
    const dir = resolveConfigDir({
      configDirFlag: undefined,
      configDirEnv: '/tmp/env-config-dir',
      claudeDirExplicit: true,
      claudeDir: '/tmp/sandbox/.claude',
    });
    expect(dir).toBe('/tmp/env-config-dir');
  });

  it('the --config-dir flag beats everything, including the env var', () => {
    const dir = resolveConfigDir({
      configDirFlag: '/tmp/flag-config-dir',
      configDirEnv: '/tmp/env-config-dir',
      claudeDirExplicit: true,
      claudeDir: '/tmp/sandbox/.claude',
    });
    expect(dir).toBe('/tmp/flag-config-dir');
  });

  it('resolves a relative TAGCONN_CONFIG_DIR env value against the cwd', () => {
    const dir = resolveConfigDir({
      configDirFlag: undefined,
      configDirEnv: 'relative-config-dir',
      claudeDirExplicit: false,
      claudeDir: DEFAULT_CLAUDE_DIR,
    });
    expect(dir).toBe(join(process.cwd(), 'relative-config-dir'));
  });
});
