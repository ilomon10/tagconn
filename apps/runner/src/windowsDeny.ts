// Windows deny rules (M11 Wave 1 review H1, decision #28). There is no sandbox on win32, so the deny list
// is the only guard for credential stores, persistence points and tagconn's own state. Every rule path is
// emitted in every candidate absolute form (absoluteRulePathFormsWin32: `//C:/x`, `C:/x`, `//c:/x`, `c:/x`).
// Paths derive from the env (APPDATA, LOCALAPPDATA, USERPROFILE, OneDrive) with fallbacks under the home dir.

import path from 'node:path';
import { absoluteRulePathFormsWin32 } from '@tagconn/shared';

const w = path.win32;

export const WIN_READ_TOOLS = ['Read'] as const;
export const WIN_EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;
const ALL_TOOLS = [...WIN_READ_TOOLS, ...WIN_EDIT_TOOLS] as const;

/** `Tool(<form>)` for each tool and each absolute-path form of one Windows path or glob. */
export function winDenyRules(tools: readonly string[], winPath: string): string[] {
  const forms = absoluteRulePathFormsWin32(winPath);
  return tools.flatMap((tool) => forms.map((form) => `${tool}(${form})`));
}

function dedupe(items: readonly string[]): string[] {
  return Array.from(new Set(items));
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.trim() !== '' ? v : undefined;
}

/** Resolved %APPDATA%, %LOCALAPPDATA% and profile dir, each with a fallback under `home`. */
export function windowsBases(env: NodeJS.ProcessEnv, home: string): { appData: string; localAppData: string; profile: string } {
  return {
    appData: nonEmpty(env.APPDATA) ?? w.join(home, 'AppData', 'Roaming'),
    localAppData: nonEmpty(env.LOCALAPPDATA) ?? w.join(home, 'AppData', 'Local'),
    profile: nonEmpty(env.USERPROFILE) ?? home,
  };
}

/**
 * The Windows sensitive-path deny list, as complete `Tool(path)` rules in both absolute forms.
 *  - Read+Edit (credential stores and tokens): read AND write denied.
 *  - Edit/Write only (persistence points, PATH-resolved bins, shell/editor startup): read stays allowed.
 */
export function windowsSensitiveDenyRules(env: NodeJS.ProcessEnv, home: string): string[] {
  const { appData, localAppData, profile } = windowsBases(env, home);
  const j = w.join;

  const readAndEdit = [
    ...['Credentials', 'Protect', 'Vault'].map((d) => j(appData, 'Microsoft', d, '**')),
    ...['Credentials', 'Vault'].map((d) => j(localAppData, 'Microsoft', d, '**')),
    j(localAppData, 'Google', 'Chrome', 'User Data', '**'),
    j(localAppData, 'Microsoft', 'Edge', 'User Data', '**'),
    j(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data', '**'),
    j(appData, 'Mozilla', 'Firefox', 'Profiles', '**'),
    j(localAppData, 'Mozilla', 'Firefox', 'Profiles', '**'),
    j(appData, 'GitHub CLI', '**'),
    j(appData, 'gcloud', '**'),
    j(appData, 'npm', 'etc', 'npmrc'),
    j(appData, 'pip', 'pip.ini'),
    j(appData, 'NuGet', 'NuGet.Config'),
    j(profile, '.nuget', '**'),
    j(appData, 'Code', 'User', 'globalStorage', '**'),
  ];

  const oneDrive = [env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].map(nonEmpty).filter((v): v is string => v !== undefined);
  const docsDirs = [j(profile, 'Documents'), ...oneDrive.map((d) => j(d, 'Documents'))];
  const editOnly = [
    j(appData, 'npm', '**'),
    j(localAppData, 'pnpm', '**'),
    j(profile, '.local', 'bin', '**'),
    j(profile, '.local', 'share', 'claude', '**'),
    j(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '**'),
    ...docsDirs.flatMap((d) => [j(d, 'PowerShell', '*profile.ps1'), j(d, 'WindowsPowerShell', '*profile.ps1')]),
    ...['settings.json', 'tasks.json', 'keybindings.json'].map((f) => j(appData, 'Code', 'User', f)),
    j(localAppData, 'Packages', 'Microsoft.WindowsTerminal_*', 'LocalState', 'settings.json'),
    j(localAppData, 'Packages', 'Microsoft.WindowsTerminalPreview_*', 'LocalState', 'settings.json'),
  ];

  return dedupe([...readAndEdit.flatMap((p) => winDenyRules(ALL_TOOLS, p)), ...editOnly.flatMap((p) => winDenyRules(WIN_EDIT_TOOLS, p))]);
}

/**
 * tagconn's own directories, from the runner's REAL paths (not just ~/.config/tagconn): the dir holding the
 * runner.json in use (token), the state dir, %LOCALAPPDATA%\tagconn (incl. data) and %APPDATA%\tagconn.
 */
export function tagconnOwnDirs(env: NodeJS.ProcessEnv, home: string, opts: { configPath?: string; stateDir?: string }): string[] {
  const { appData, localAppData } = windowsBases(env, home);
  const dirs = [w.join(localAppData, 'tagconn'), w.join(appData, 'tagconn')];
  if (opts.configPath) dirs.push(w.dirname(opts.configPath));
  if (opts.stateDir) dirs.push(opts.stateDir);
  return dedupe(dirs);
}

/** Read/Edit/Write/MultiEdit/NotebookEdit denies for `<dir>/**` of each dir, in every absolute form. */
export function windowsTagconnDirDenyRules(dirs: readonly string[]): string[] {
  return dedupe(dirs.flatMap((d) => winDenyRules(ALL_TOOLS, `${d.replace(/[\\/]+$/, '')}\\**`)));
}
