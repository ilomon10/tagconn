import { homedir as osHomedir } from 'node:os';
import nodePath from 'node:path';

export interface PathInputs {
  /** Injectable for tests (default: process.platform). */
  platform?: NodeJS.Platform;
  /** Injectable for tests (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Injectable for tests (default: os.homedir()). */
  homedir?: string;
  /**
   * POSIX only: ignore XDG_CONFIG_HOME and use ~/.config/tagconn, which is where office-hook.sh looks for
   * curl.conf. The scripts/*.ts CLIs set this to keep their long-standing behaviour; the desktop app does not.
   */
  legacyPosixConfig?: boolean;
}

export interface SetupPaths {
  /** hook.json, curl.conf, runner.json, the installed hook script. */
  config: string;
  /** The runner's state (run logs, pid files). */
  state: string;
  /** The server's SQLite database. */
  data: string;
  /** Claude Code's config dir (settings.json, agents, skills). */
  claudeDir: string;
}

/** The path module matching `platform`, so win32 paths can be built and tested on Linux. */
export function pathFor(platform: NodeJS.Platform): typeof nodePath.posix {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** Like `||`, but for env vars: an unset or empty value falls through. */
function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key];
  return v ? v : undefined;
}

/**
 * Where tagconn keeps things on this OS:
 * - config: %APPDATA%\tagconn | $XDG_CONFIG_HOME/tagconn | ~/.config/tagconn
 * - state:  %LOCALAPPDATA%\tagconn\state | $XDG_STATE_HOME/tagconn | ~/.local/state/tagconn
 * - data:   %LOCALAPPDATA%\tagconn\data | $XDG_DATA_HOME/tagconn | ~/.local/share/tagconn
 * - claudeDir: $CLAUDE_CONFIG_DIR | ~/.claude
 */
export function resolveSetupPaths(inputs: PathInputs = {}): SetupPaths {
  const platform = inputs.platform ?? process.platform;
  const env = inputs.env ?? process.env;
  const home = inputs.homedir ?? osHomedir();
  const p = pathFor(platform);
  const claudeEnv = envValue(env, 'CLAUDE_CONFIG_DIR');
  const claudeDir = claudeEnv ? p.resolve(claudeEnv) : p.join(home, '.claude');

  if (platform === 'win32') {
    const appData = envValue(env, 'APPDATA') ?? p.join(home, 'AppData', 'Roaming');
    const localAppData = envValue(env, 'LOCALAPPDATA') ?? p.join(home, 'AppData', 'Local');
    return {
      config: p.join(appData, 'tagconn'),
      state: p.join(localAppData, 'tagconn', 'state'),
      data: p.join(localAppData, 'tagconn', 'data'),
      claudeDir,
    };
  }
  const xdgConfig = inputs.legacyPosixConfig ? undefined : envValue(env, 'XDG_CONFIG_HOME');
  return {
    config: p.join(xdgConfig ?? p.join(home, '.config'), 'tagconn'),
    state: p.join(envValue(env, 'XDG_STATE_HOME') ?? p.join(home, '.local', 'state'), 'tagconn'),
    data: p.join(envValue(env, 'XDG_DATA_HOME') ?? p.join(home, '.local', 'share'), 'tagconn'),
    claudeDir,
  };
}

export interface ResolveConfigDirInputs {
  configDirFlag: string | undefined;
  configDirEnv: string | undefined;
  claudeDirExplicit: boolean;
  claudeDir: string;
}

/**
 * Resolves the config dir (holds curl.conf/hook.json + the installed copy of the hook script):
 * --config-dir flag > TAGCONN_CONFIG_DIR env > derived from a non-default claude dir > the OS default.
 * Without this, a sandboxed --claude-dir/CLAUDE_CONFIG_DIR install (or --project) would still write the
 * real config dir, and two side-by-side installs would clobber each other's token and hook script.
 */
export function resolveConfigDir(inputs: ResolveConfigDirInputs, pathInputs: PathInputs = {}): string {
  const platform = pathInputs.platform ?? process.platform;
  const p = pathFor(platform);
  if (inputs.configDirFlag) {
    return inputs.configDirFlag;
  }
  if (inputs.configDirEnv) {
    return p.resolve(inputs.configDirEnv);
  }
  const home = pathInputs.homedir ?? osHomedir();
  if (inputs.claudeDirExplicit && p.resolve(inputs.claudeDir) !== p.join(home, '.claude')) {
    return p.join(p.dirname(inputs.claudeDir), '.config', 'tagconn');
  }
  return resolveSetupPaths(pathInputs).config;
}
