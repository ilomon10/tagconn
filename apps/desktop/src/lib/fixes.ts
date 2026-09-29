import type { FixAction, SetupFix } from '@tagconn/shared';

/** The side effects a fix button needs; injected so the mapping is testable without tauri. */
export interface FixEnv {
  recheck: () => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  revealPath: (path: string) => Promise<void>;
  /** Next free port after `current`, then config.set + recheck. */
  useNextFreePort: () => Promise<void>;
  chooseDataDir: () => Promise<void>;
  /** Goes to the Install hooks step (installing needs an explicit click there). */
  gotoHooks: () => void;
  switchToNative: () => Promise<void>;
}

export const RELEASES_URL = 'https://github.com/ilomon10/tagconn/releases';

export async function runFix(fix: SetupFix, env: FixEnv): Promise<void> {
  const need = (v: string | undefined) => {
    if (!v) throw new Error(`"${fix.label}" has no target.`);
    return v;
  };
  const table: Record<FixAction, () => Promise<void> | void> = {
    recheck: env.recheck,
    open_url: () => env.openUrl(need(fix.target)),
    open_file: () => env.revealPath(need(fix.target)),
    use_next_free_port: env.useNextFreePort,
    choose_data_dir: env.chooseDataDir,
    install_hooks: env.gotoHooks,
    switch_to_native: env.switchToNative,
    reinstall_app: () => env.openUrl(RELEASES_URL),
  };
  await table[fix.action]();
}
