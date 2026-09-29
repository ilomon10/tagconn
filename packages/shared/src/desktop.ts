import { z } from 'zod';

/**
 * tagconn Desktop (M11, docs/design/desktop.md): the contract between the Tauri shell/UI and the Node
 * supervisor sidecar. Messages are newline-delimited JSON over the sidecar's stdin/stdout, so there is no
 * network port and no token. Requests carry an `id`; the supervisor answers each with one response and
 * may push notifications (no `id`) at any time.
 */
export const DESKTOP_RPC_VERSION = 1;

export const SERVICE_IDS = ['server', 'runner', 'docker'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

/** `unavailable` = can't run here (e.g. `docker` without Docker, `runner` without the Claude CLI). */
export const SERVICE_STATES = ['stopped', 'starting', 'running', 'stopping', 'crashed', 'unavailable'] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

export const RUN_MODES = ['native', 'docker'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const CHECK_STATUSES = ['ok', 'warn', 'fail', 'skip'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** Every setup check the wizard can show (design doc, "Setup (wizard) failures"). */
export const SETUP_CHECK_IDS = [
  'claude_cli',
  'claude_login',
  'git_bash',
  'server_port',
  'config_dir',
  'data_dir',
  'claude_settings',
  'hooks',
  'docker',
  'webview2',
  'runner_platform',
] as const;
export type SetupCheckId = (typeof SETUP_CHECK_IDS)[number];

/** A one-click fix the UI can offer next to a failed check. */
export const FIX_ACTIONS = ['recheck', 'open_url', 'open_file', 'use_next_free_port', 'choose_data_dir', 'install_hooks', 'switch_to_native', 'reinstall_app'] as const;
export type FixAction = (typeof FIX_ACTIONS)[number];

export const SetupFixSchema = z.object({
  label: z.string(),
  action: z.enum(FIX_ACTIONS),
  /** For `open_url` / `open_file`. */
  target: z.string().optional(),
});
export type SetupFix = z.infer<typeof SetupFixSchema>;

export const SetupCheckSchema = z.object({
  id: z.enum(SETUP_CHECK_IDS),
  title: z.string(),
  status: z.enum(CHECK_STATUSES),
  /** Short cause, shown under the title ("claude 2.1.283 found at C:\\…"). */
  detail: z.string(),
  /** A `fail` on a required check blocks "Start services"; a `warn` never does. */
  required: z.boolean(),
  fix: SetupFixSchema.optional(),
});
export type SetupCheck = z.infer<typeof SetupCheckSchema>;

export const DesktopConfigSchema = z.object({
  runMode: z.enum(RUN_MODES),
  serverPort: z.number().int().min(1024).max(65535),
  /** Folders quests and the Receptionist's project scope may use (runner.allowedProjectDirs). */
  allowedProjectDirs: z.array(z.string()),
  /** Write `.tagconn/README.md` into repos (opt-in, default off). */
  attributionReadme: z.boolean(),
  /** Start the services when the app starts. */
  autoStartServices: z.boolean(),
  /** Open the office window once the server is up. */
  openOfficeOnStart: z.boolean(),
  /** Custom data dir (SQLite DB); null = the OS default. */
  dataDir: z.string().nullable(),
});
export type DesktopConfig = z.infer<typeof DesktopConfigSchema>;

export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  runMode: 'native',
  serverPort: 4317,
  allowedProjectDirs: [],
  attributionReadme: false,
  autoStartServices: true,
  openOfficeOnStart: true,
  dataDir: null,
};

export const ServiceStatusSchema = z.object({
  id: z.enum(SERVICE_IDS),
  state: z.enum(SERVICE_STATES),
  pid: z.number().int().optional(),
  /** Epoch ms of the last state change. */
  since: z.number(),
  /** Automatic restarts since the user last pressed Start. */
  restarts: z.number().int(),
  /** Why it crashed / is unavailable, with the next step. */
  lastError: z.string().optional(),
  /** e.g. the office URL for `server`. */
  url: z.string().optional(),
});
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export const LogLineSchema = z.object({
  service: z.union([z.enum(SERVICE_IDS), z.literal('supervisor')]),
  ts: z.number(),
  stream: z.enum(['stdout', 'stderr', 'supervisor']),
  /** Already redacted (tokens masked) by the supervisor. */
  line: z.string(),
});
export type LogLine = z.infer<typeof LogLineSchema>;

export const AppInfoSchema = z.object({
  rpcVersion: z.number().int(),
  appVersion: z.string(),
  nodeVersion: z.string(),
  platform: z.string(),
  arch: z.string(),
  paths: z.object({ config: z.string(), state: z.string(), data: z.string(), claudeDir: z.string() }),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

export const PairCodeSchema = z.object({ code: z.string(), url: z.string(), expiresAt: z.number() });
export type PairCode = z.infer<typeof PairCodeSchema>;

export const InstallResultSchema = z.object({
  /** Files written or changed, for the "what changed" summary. */
  changed: z.array(z.string()),
  /** The settings.json backup, if one was made. */
  backup: z.string().nullable(),
});
export type InstallResult = z.infer<typeof InstallResultSchema>;

const ServiceParams = z.object({ id: z.enum(SERVICE_IDS) });

/** Method → params and result schemas. The UI's typed client and the supervisor's dispatcher both use this. */
export const DESKTOP_METHODS = {
  'app.info': { params: z.object({}), result: AppInfoSchema },
  'setup.check': { params: z.object({}), result: z.array(SetupCheckSchema) },
  'setup.install': { params: z.object({}), result: InstallResultSchema },
  'setup.uninstall': { params: z.object({}), result: InstallResultSchema },
  'config.get': { params: z.object({}), result: DesktopConfigSchema },
  'config.set': { params: DesktopConfigSchema.partial(), result: DesktopConfigSchema },
  'service.status': { params: z.object({}), result: z.array(ServiceStatusSchema) },
  'service.start': { params: ServiceParams, result: ServiceStatusSchema },
  'service.stop': { params: ServiceParams, result: ServiceStatusSchema },
  'service.restart': { params: ServiceParams, result: ServiceStatusSchema },
  'logs.tail': { params: z.object({ service: z.union([z.enum(SERVICE_IDS), z.literal('supervisor')]), lines: z.number().int().min(1).max(2000) }), result: z.array(LogLineSchema) },
  'pair.mint': { params: z.object({}), result: PairCodeSchema },
  'diagnostics.collect': { params: z.object({}), result: z.object({ text: z.string() }) },
} as const;
export type DesktopMethod = keyof typeof DESKTOP_METHODS;
export type DesktopParams<M extends DesktopMethod> = z.input<(typeof DESKTOP_METHODS)[M]['params']>;
export type DesktopResult<M extends DesktopMethod> = z.infer<(typeof DESKTOP_METHODS)[M]['result']>;

export const RPC_ERROR_CODES = [
  'invalid_request',
  'unknown_method',
  'busy',
  'check_failed',
  'install_failed',
  'rolled_back',
  'spawn_failed',
  'port_in_use',
  'docker_unavailable',
  'not_running',
  'internal',
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export const RpcErrorSchema = z.object({
  code: z.enum(RPC_ERROR_CODES),
  message: z.string(),
  /** The one next step to show ("Close the app using port 4317, or use port 4318"). */
  hint: z.string().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

export const RpcRequestSchema = z.object({ id: z.number().int(), method: z.string(), params: z.unknown().optional() });
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export type RpcResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: RpcError };

export const DESKTOP_NOTIFICATIONS = {
  'service.changed': ServiceStatusSchema,
  'log.line': LogLineSchema,
} as const;
export type DesktopNotificationMethod = keyof typeof DESKTOP_NOTIFICATIONS;
export type RpcNotification = { [M in DesktopNotificationMethod]: { method: M; params: z.infer<(typeof DESKTOP_NOTIFICATIONS)[M]> } }[DesktopNotificationMethod];
