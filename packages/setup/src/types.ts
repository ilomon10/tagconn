// Minimal copies of the desktop RPC types from packages/shared/src/desktop.ts (SetupCheck, InstallResult).
//
// Why duplicated instead of imported: scripts/*.ts run with plain `node file.ts`, and node refuses to
// strip types under node_modules, so this package can't depend on @tagconn/shared (zod, resolved through
// node_modules). The shapes are structurally identical, so the supervisor can hand them straight to the
// zod-validated RPC layer, and test/contract.test.ts pins them against the shared schemas' id/status lists.

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export type SetupCheckId =
  | 'claude_cli'
  | 'claude_login'
  | 'git_bash'
  | 'server_port'
  | 'config_dir'
  | 'data_dir'
  | 'claude_settings'
  | 'hooks'
  | 'docker'
  | 'webview2'
  | 'runner_platform';

export type FixAction =
  | 'recheck'
  | 'open_url'
  | 'open_file'
  | 'use_next_free_port'
  | 'choose_data_dir'
  | 'install_hooks'
  | 'switch_to_native'
  | 'reinstall_app';

export interface SetupFix {
  label: string;
  action: FixAction;
  /** For `open_url` / `open_file`. */
  target?: string;
}

export interface SetupCheck {
  id: SetupCheckId;
  title: string;
  status: CheckStatus;
  detail: string;
  required: boolean;
  fix?: SetupFix;
}

export interface InstallResult {
  /** Files written or changed, for the "what changed" summary. */
  changed: string[];
  /** The settings.json backup, if one was made. */
  backup: string | null;
}
