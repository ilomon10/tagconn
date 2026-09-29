import { defaultFs, writeFileAtomic, type FsOps } from './fsutil.ts';
import { touch, type SetupContext } from './context.ts';

export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Notification',
  'PreCompact',
];

// Events for which Claude Code only honors a "matcher" field. The rest omit it.
const MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

const SH_HOOK_MARKER = 'tagconn/office-hook.sh';
const NODE_HOOK_FILE = /(^|[\\/])office-hook\.mjs$/;

export type HookKind = 'sh' | 'node';

/** The sh hook: today's command string (packages/hook/office-hook.sh through `sh -c`). */
export interface ShHookSpec {
  kind: 'sh';
  scriptPath: string;
  confPath: string;
  isDefaultConfigDir: boolean;
}

/** The node hook, in Claude Code's exec form (no shell, so no quoting differences on Windows). */
export interface NodeHookSpec {
  kind: 'node';
  nodePath: string;
  scriptPath: string;
}

export type HookSpec = ShHookSpec | NodeHookSpec;

export type HookEntry = { type: string; command: string; args?: string[]; [k: string]: unknown };
export type MatcherGroup = { matcher?: string; hooks: HookEntry[]; [k: string]: unknown };
export type SettingsJson = { hooks?: Record<string, MatcherGroup[]>; [k: string]: unknown };

/**
 * Index of the first character where `text` stops being valid JSON (undefined if it parses). A small
 * recursive-descent scanner, only used to point the user at the right line/column.
 */
export function jsonErrorIndex(text: string): number | undefined {
  let i = 0;
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i] as string)) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const lit = (word: string) => {
    if (text.startsWith(word, i)) i += word.length;
    else fail();
  };
  const str = () => {
    i++; // opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if ((text.charCodeAt(i) ?? 0) < 0x20) fail();
      i++;
    }
    if (text[i] !== '"') fail();
    i++;
  };
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) fail();
    i += (m as RegExpExecArray)[0].length;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') return void i++;
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        str();
        ws();
        if (text[i] !== ':') fail();
        i++;
        value();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') return void i++;
        fail();
      }
    } else if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') return void i++;
      for (;;) {
        value();
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') return void i++;
        fail();
      }
    } else if (c === '"') str();
    else if (c === 't') lit('true');
    else if (c === 'f') lit('false');
    else if (c === 'n') lit('null');
    else num();
  };
  try {
    value();
    ws();
    return i < text.length ? i : undefined;
  } catch (at) {
    return typeof at === 'number' ? Math.min(at, text.length) : undefined;
  }
}

/** settings.json exists but is not valid JSON. It is never overwritten; `line`/`column` are 1-based. */
export class SettingsParseError extends Error {
  readonly code = 'settings_unparsable';
  readonly path: string;
  readonly position: number | undefined;
  readonly line: number | undefined;
  readonly column: number | undefined;
  constructor(path: string, cause: Error, text: string) {
    const m = /position (\d+)/.exec(cause.message);
    // Node 24's JSON.parse messages often carry no position: find it with a small scanner instead.
    const position = m ? Number(m[1]) : jsonErrorIndex(text);
    let line: number | undefined;
    let column: number | undefined;
    if (position !== undefined) {
      const before = text.slice(0, position).split('\n');
      line = before.length;
      column = (before[before.length - 1] ?? '').length + 1;
    }
    const where = line !== undefined ? ` (line ${line}, column ${column})` : '';
    super(`Failed to parse ${path} as JSON: ${cause.message}${where}`);
    this.name = 'SettingsParseError';
    this.path = path;
    this.position = position;
    this.line = line;
    this.column = column;
  }
}

/** The install failed part-way and settings.json was put back as it was. */
export class SettingsRollbackError extends Error {
  readonly code = 'settings_rolled_back';
  readonly path: string;
  readonly backup: string | null;
  /** False when even the restore failed; `backup` then holds the good copy for a manual restore. */
  readonly restored: boolean;
  constructor(path: string, backup: string | null, restored: boolean, cause: unknown) {
    const reason = (cause as Error)?.message ?? String(cause);
    super(
      restored
        ? `Writing ${path} failed (${reason}); it was restored from the backup${backup ? ` ${backup}` : ''}.`
        : `Writing ${path} failed (${reason}) and it could NOT be restored automatically. ` +
            (backup ? `Copy ${backup} over it.` : 'It did not exist before; delete it.'),
      { cause },
    );
    this.name = 'SettingsRollbackError';
    this.path = path;
    this.backup = backup;
    this.restored = restored;
  }
}

/** True for a legacy sh command string (both forms `hookEntryFor` writes). */
export function isOurCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  if (command.includes(SH_HOOK_MARKER)) return true;
  // Non-default config dir form: the config dir need not be named "tagconn" (a custom --config-dir), so
  // also match on our distinctive env var name plus the script name.
  return command.includes('TAGCONN_CURL_CONF=') && command.includes('office-hook.sh');
}

/** Which of our hook kinds an entry is, or null when it is not ours. */
export function hookKindOf(entry: { command?: unknown; args?: unknown } | null | undefined): HookKind | null {
  if (!entry) return null;
  if (isOurCommand(entry.command)) return 'sh';
  if (Array.isArray(entry.args) && entry.args.some((a) => typeof a === 'string' && NODE_HOOK_FILE.test(a))) return 'node';
  return null;
}

export function isOurEntry(entry: { command?: unknown; args?: unknown } | null | undefined): boolean {
  return hookKindOf(entry) !== null;
}

export function ourCommand(hookScriptPath: string, confPath: string, isDefaultConfigDir: boolean): string {
  if (isDefaultConfigDir) {
    // Quote in case the path contains spaces (e.g. a HOME with spaces).
    return `"${hookScriptPath}"`;
  }
  // Non-default config dir: the hook script's own default ($HOME/.config/tagconn/curl.conf) would be wrong
  // here, so point it at its conf file explicitly. Paths are single-quoted and were validated
  // (validateNoSingleQuote) to contain no single quote.
  return `TAGCONN_CURL_CONF='${confPath}' '${hookScriptPath}'`;
}

export function hookEntryFor(spec: HookSpec): HookEntry {
  if (spec.kind === 'sh') {
    return { type: 'command', command: ourCommand(spec.scriptPath, spec.confPath, spec.isDefaultConfigDir) };
  }
  return { type: 'command', command: spec.nodePath, args: [spec.scriptPath] };
}

function sameEntry(a: HookEntry, b: HookEntry): boolean {
  return a.command === b.command && JSON.stringify(a.args ?? null) === JSON.stringify(b.args ?? null);
}

/**
 * Adds our hook entry to every event. Idempotent: an existing entry of the same kind is left alone (sh: any
 * command of ours, as before; node: only when it is exactly this node + script), and an entry of the OTHER
 * kind (or a node entry with a stale path) is replaced, so switching kinds never leaves two hooks firing.
 */
export function installHooks(settings: SettingsJson, spec: HookSpec): { added: number; skipped: number } {
  settings.hooks = settings.hooks || {};
  const entry = hookEntryFor(spec);
  let added = 0;
  let skipped = 0;
  for (const event of HOOK_EVENTS) {
    let groups = settings.hooks[event] || [];
    const ours = groups.flatMap((g) => g.hooks || []).filter(isOurEntry);
    const upToDate =
      ours.length > 0 && ours.every((h) => hookKindOf(h) === spec.kind) && (spec.kind === 'sh' || ours.some((h) => sameEntry(h, entry)));
    if (upToDate) {
      settings.hooks[event] = groups;
      skipped++;
      continue;
    }
    if (ours.length > 0) groups = removeOurs(groups).groups;
    settings.hooks[event] = groups;
    const fresh: HookEntry = { ...entry };
    if (MATCHER_EVENTS.has(event)) {
      // Append to an existing "*" matcher group if present, else create one.
      const starGroup = groups.find((g) => g.matcher === '*');
      if (starGroup) {
        starGroup.hooks = [...(starGroup.hooks || []), fresh];
      } else {
        groups.push({ matcher: '*', hooks: [fresh] });
      }
    } else {
      groups.push({ hooks: [fresh] });
    }
    added++;
  }
  return { added, skipped };
}

function removeOurs(groups: MatcherGroup[]): { groups: MatcherGroup[]; removed: number } {
  let removed = 0;
  const next: MatcherGroup[] = [];
  for (const group of groups) {
    const kept = (group.hooks || []).filter((h) => {
      const ours = isOurEntry(h);
      if (ours) removed++;
      return !ours;
    });
    if (kept.length > 0) next.push({ ...group, hooks: kept });
  }
  return { groups: next, removed };
}

/** Removes only our entries (either kind); everything else, including other hooks in the same group, stays. */
export function uninstallHooks(settings: SettingsJson): { removed: number } {
  if (!settings.hooks) return { removed: 0 };
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const res = removeOurs(settings.hooks[event] || []);
    removed += res.removed;
    if (res.groups.length > 0) {
      settings.hooks[event] = res.groups;
    } else {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
  return { removed };
}

/** Which hooks are in a parsed settings.json: the kind (or `mixed`) and how many of the events have one. */
export function summarizeHooks(settings: SettingsJson): { kind: HookKind | 'mixed' | null; events: number; sample?: HookEntry } {
  const kinds = new Set<HookKind>();
  let events = 0;
  let sample: HookEntry | undefined;
  for (const event of HOOK_EVENTS) {
    let present = false;
    for (const g of settings.hooks?.[event] ?? []) {
      for (const h of g.hooks ?? []) {
        const kind = hookKindOf(h);
        if (kind) {
          present = true;
          kinds.add(kind);
          sample ??= h;
        }
      }
    }
    if (present) events++;
  }
  const kind = kinds.size === 0 ? null : kinds.size === 1 ? ([...kinds][0] as HookKind) : 'mixed';
  return { kind, events, sample };
}

/** Copies settings.json to a timestamped sibling. Returns the backup path (or null: no file / dry run). */
export function backupSettings(ctx: SetupContext, path: string, fs: FsOps = defaultFs): string | null {
  if (!fs.existsSync(path)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${path}.tagconn-backup-${ts}`;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would back up ${path} -> ${backupPath}`);
    return null;
  }
  fs.copyFileSync(path, backupPath);
  touch(ctx, backupPath);
  ctx.log(`  backed up settings to ${backupPath}`);
  return backupPath;
}

/** Reads and parses settings.json ({} if missing). Throws SettingsParseError; never touches the file. */
export function loadSettings(path: string, fs: FsOps = defaultFs): SettingsJson {
  if (!fs.existsSync(path)) return {};
  const text = fs.readFileSync(path, 'utf8');
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('top-level value is not an object');
    }
    return parsed as SettingsJson;
  } catch (err) {
    throw new SettingsParseError(path, err as Error, text);
  }
}

/**
 * Backup -> parse -> mutate -> atomic write -> re-read and check -> (on any failure) restore the backup.
 * A parse failure aborts before anything is written, so an unparsable file is never overwritten.
 */
function mutateSettings(
  ctx: SetupContext,
  path: string,
  mutate: (settings: SettingsJson) => void,
  check: (written: SettingsJson) => void,
  fs: FsOps,
): { backup: string | null } {
  const backup = backupSettings(ctx, path, fs);
  const settings = loadSettings(path, fs);
  mutate(settings);
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] would write ${path}`);
    return { backup: null };
  }
  const existed = fs.existsSync(path);
  try {
    writeFileAtomic(path, JSON.stringify(settings, null, 2) + '\n', fs);
    check(loadSettings(path, fs));
  } catch (err) {
    let restored = false;
    try {
      if (backup && existed) {
        const tmp = `${path}.tagconn-restore-${process.pid}`;
        fs.copyFileSync(backup, tmp);
        fs.renameSync(tmp, path);
      } else if (!existed) {
        fs.rmSync(path, { force: true });
      }
      restored = true;
    } catch {
      restored = false;
    }
    throw new SettingsRollbackError(path, backup, restored, err);
  }
  touch(ctx, path);
  return { backup };
}

export function installClaudeHooks(
  ctx: SetupContext,
  settingsPath: string,
  spec: HookSpec,
  fs: FsOps = defaultFs,
): { added: number; skipped: number; backup: string | null } {
  let counts = { added: 0, skipped: 0 };
  const { backup } = mutateSettings(
    ctx,
    settingsPath,
    (s) => {
      counts = installHooks(s, spec);
    },
    (written) => {
      const sum = summarizeHooks(written);
      if (sum.kind !== spec.kind || sum.events !== HOOK_EVENTS.length) {
        throw new Error('the written settings.json does not contain the hook entries');
      }
    },
    fs,
  );
  return { ...counts, backup };
}

export function uninstallClaudeHooks(
  ctx: SetupContext,
  settingsPath: string,
  fs: FsOps = defaultFs,
): { removed: number; backup: string | null } {
  let removed = 0;
  const { backup } = mutateSettings(
    ctx,
    settingsPath,
    (s) => {
      removed = uninstallHooks(s).removed;
    },
    (written) => {
      if (summarizeHooks(written).kind !== null) throw new Error('tagconn hook entries are still present after the write');
    },
    fs,
  );
  return { removed, backup };
}
