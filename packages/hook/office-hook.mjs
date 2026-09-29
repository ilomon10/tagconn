#!/usr/bin/env node
// tagconn Claude Code hook, cross-platform Node port of office-hook.sh (M11 Wave 1).
//
// Reads a Claude Code hook event (JSON) from stdin and forwards it, verbatim, to the
// tagconn office server. Like the sh hook it must NEVER break the Claude Code session:
//   - always exits 0, no matter what happens (top-level try/catch, process-level
//     handlers, and a failsafe timer that exits 0 inside the 1 s budget)
//   - never writes to stdout (some hook events read stdout back!); stderr only when
//     TAGCONN_HOOK_DEBUG=1
//   - never blocks noticeably when the server is slow or down (request timer + failsafe timer)
//   - is a no-op when OFFICE_DISABLED=1, TAGCONN_RUN_KIND=receptionist, or config is
//     missing/invalid
//
// Config: <configDir>/hook.json = { version: 1, url, token, attributionReadme [, attributionImport] }.
//   hook.json path: TAGCONN_HOOK_CONFIG (a file path), else <configDir>/hook.json where
//   configDir is TAGCONN_CONFIG_DIR, else %APPDATA%\tagconn (win32) or
//   $XDG_CONFIG_HOME/tagconn or ~/.config/tagconn. The event is POSTed to <url>/api/hooks
//   with the x-office-token header; the README template is <configDir>/attribution-README.md.
//   The env overrides are honoured only inside the user's home / OS config dir. On POSIX hook.json
//   must be owned by the user and not group/world-writable; the token must be 16-128 hex chars.
//   (The sh hook does not check curl.conf's mode.)
//
// Attribution (SessionStart only, see office-hook.sh): the .tagconn/README.md write (only
// when attributionReadme is true) and the .tagconn/office.json import POST (on unless
// attributionImport is false; the sh hook gates it on attribution.conf existing).
// Detached choice: the event POST is awaited first, then a detached child (this same file,
// `--attribution`) is spawned with unref() and the parent exits at once. The alternative,
// finishing inline, would add filesystem work plus a second POST (up to a whole second)
// to the latency Claude Code waits on, while a spawn costs ~1 ms in the parent.
import { spawn } from 'node:child_process';
import { closeSync, constants as fsc, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_BODY_BYTES = 32 * 1024 * 1024; // beyond this we do not forward (the server rejects far less)
export const SESSION_START_SCAN_MAX = 16384; // same cap as the sh hook's sed check
export const IMPORT_MAX_BYTES = 65536;
export const README_MAX_BYTES = 65536;
const EVENT_TIMEOUT_MS = 850;
const FAILSAFE_MS = 950;

const debugOn = () => process.env.TAGCONN_HOOK_DEBUG === '1';
const dbg = (...a) => {
  if (debugOn()) {
    try {
      process.stderr.write(`[tagconn-hook] ${a.join(' ')}\n`);
    } catch {}
  }
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests; `p` is path.posix or path.win32)
// ---------------------------------------------------------------------------

/** Resolves { hookJson, configDir } from env, following the platform's conventions. `scriptDir` +
 *  `exists`: the installer always copies this script next to its hook.json, and an exec-form hook
 *  (command + args, no shell) gets no env overrides, so a hook.json beside the script wins over the
 *  OS default (this is what makes a custom config dir work). */
export function resolveConfigPaths(env, platform, home, scriptDir, exists) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  // The env overrides are honoured only when they land inside the user's home or the OS config dir:
  // a project-level env (.env, settings) could otherwise point the hook at a repo-relative config
  // (token + URL of an attacker's choosing). Otherwise they are ignored and we fall back.
  const roots = allowedConfigRoots(env, platform, home);
  const okEnv = (v) => insideAny(p.resolve(v), roots, platform);
  if (env.TAGCONN_HOOK_CONFIG && okEnv(env.TAGCONN_HOOK_CONFIG)) {
    const hookJson = p.resolve(env.TAGCONN_HOOK_CONFIG);
    return { hookJson, configDir: p.dirname(hookJson) };
  }
  let configDir;
  if (env.TAGCONN_CONFIG_DIR && okEnv(env.TAGCONN_CONFIG_DIR)) configDir = p.resolve(env.TAGCONN_CONFIG_DIR);
  else if (scriptDir && exists && exists(p.join(scriptDir, 'hook.json'))) configDir = scriptDir;
  else if (platform === 'win32') configDir = p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'tagconn');
  else configDir = p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'tagconn');
  return { hookJson: p.join(configDir, 'hook.json'), configDir };
}

/** Roots an env-supplied config path may live under: home plus the OS config dirs. */
export function allowedConfigRoots(env, platform, home) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const roots = [home];
  if (platform === 'win32') roots.push(env.APPDATA || p.join(home, 'AppData', 'Roaming'));
  else roots.push(env.XDG_CONFIG_HOME || p.join(home, '.config'));
  return roots.filter(Boolean).map((r) => p.resolve(r));
}

/** True when `target` is one of `roots` or below it (case-insensitive on win32). Lexical. */
export function insideAny(target, roots, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (x) => (platform === 'win32' ? p.resolve(x).toLowerCase() : p.resolve(x));
  const t = norm(target);
  return roots.some((r) => {
    const rel = p.relative(norm(r), t);
    return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
  });
}

/** True when a and b are the same filesystem object (dev + ino); the symlink-swap check. */
export function sameInode(a, b) {
  return !!a && !!b && a.dev === b.dev && a.ino === b.ino;
}

/** L4: win32 has no cheap ownership check, so README writes and imports are limited to projects
 *  under %USERPROFILE% (both canonical paths, compared case-insensitively). */
export function winProjectOutsideUserProfile(project, userProfile) {
  if (!userProfile) return true;
  return !insideAny(project, [userProfile], 'win32');
}

/** L1: 16-128 lowercase hex chars, and no CR/LF/NUL (header injection) in any header value. */
export function isValidToken(t) {
  return typeof t === 'string' && /^[0-9a-f]{16,128}$/.test(t);
}
export function hasHeaderBreak(v) {
  return typeof v === 'string' && /[\r\n\0]/.test(v);
}

/** L2: a POSIX hook.json must be ours and not group/world-writable. */
export function configFileTrusted(st, uid) {
  if (uid === undefined) return true; // win32: no POSIX ownership
  return st.uid === uid && (st.mode & 0o022) === 0;
}

/** L5: canonical home candidates; the fail-closed guard needs at least one and refuses all of them. */
export function homeGuard(project, homes, platform) {
  if (!homes.length) return { skip: true, isHome: false };
  return { skip: false, isHome: homes.some((h) => samePath(project, h, platform)) };
}

/** UUID-shaped, lowercase hex only: the same check as the sh hook's case globs. */
export function isRunIdHint(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
}

/** Session ids are restricted to [A-Za-z0-9_-]; anything else (or empty) is dropped. */
export function sanitizeSessionId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]+$/.test(v) ? v : '';
}

// Mirrors the sh hook's sed capture of a JSON string field: the LAST match on the text.
export function lastStringField(text, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, 'g');
  let last = '';
  for (const m of text.matchAll(re)) last = m[1] ?? '';
  return last;
}

/** Cheap gate first (substring), the field parse only for a small body. */
export function isSessionStart(body) {
  if (!body.includes('"SessionStart"')) return false;
  if (Buffer.byteLength(body) > SESSION_START_SCAN_MAX) return false;
  return lastStringField(body, 'hook_event_name') === 'SessionStart';
}

/** True when a is b (case-insensitive and separator-tolerant on win32). Both must be canonical. */
export function samePath(a, b, platform) {
  if (!a || !b) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const norm = (x) => {
    const n = p.normalize(x).replace(/[\\/]+$/, '');
    return platform === 'win32' ? n.toLowerCase() : n;
  };
  return norm(a) === norm(b);
}

/** True for a filesystem root ("/" or "C:\"). */
export function isFsRoot(dir, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const r = p.resolve(dir);
  return p.parse(r).root === r;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  let size = 0;
  try {
    for await (const c of process.stdin) {
      size += c.length;
      if (size <= MAX_BODY_BYTES) chunks.push(c); // keep draining past the cap so no EPIPE upstream
    }
  } catch {}
  if (size > MAX_BODY_BYTES) return null;
  return Buffer.concat(chunks);
}

function loadConfig(hookJson) {
  try {
    const fd = openSync(hookJson, 'r');
    let text;
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return null;
      if (!configFileTrusted(st, typeof process.getuid === 'function' ? process.getuid() : undefined)) return null;
      text = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
    const cfg = JSON.parse(text);
    if (!cfg || typeof cfg !== 'object' || cfg.version !== 1) return null;
    if (typeof cfg.url !== 'string' || !isValidToken(cfg.token)) return null;
    if (hasHeaderBreak(cfg.token) || hasHeaderBreak(cfg.url)) return null;
    const u = new URL(cfg.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return {
      base: cfg.url.replace(/\/+$/, ''),
      token: cfg.token,
      attributionReadme: cfg.attributionReadme === true,
      attributionImport: cfg.attributionImport !== false,
    };
  } catch {
    return null;
  }
}

// Transport: a minimal HTTP/1.1 POST over node:net for http:// (the local office server), and
// node:https (loaded lazily) for https://. Not global fetch (its first use loads undici, ~75 ms cold)
// and not node:http (~20 ms extra import): the latency budget is p50 < 60 ms including node startup.
function post(url, token, body, extraHeaders) {
  return new Promise((resolve) => {
    let done = false;
    let timer;
    let sock;
    const finish = (why) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      dbg('POST', url, why);
      try {
        sock?.destroy();
      } catch {}
      resolve();
    };
    try {
      const u = new URL(url);
      const headers = {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-office-token': token,
        ...extraHeaders,
      };
      timer = setTimeout(() => finish('timeout'), EVENT_TIMEOUT_MS);
      if (u.protocol === 'https:') {
        import('node:https')
          .then(({ default: https }) => {
            const req = https.request(u, { method: 'POST', headers }, (res) => {
              res.resume();
              finish(res.statusCode);
            });
            sock = req;
            req.on('error', (e) => finish(e?.message ?? 'error'));
            req.end(body);
          })
          .catch(() => finish('import failed'));
        return;
      }
      const head =
        `POST ${u.pathname}${u.search} HTTP/1.1\r\nhost: ${u.host}\r\nconnection: close\r\n` +
        Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        '\r\n\r\n';
      sock = net.connect({ host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || 80 });
      sock.on('connect', () => {
        sock.write(head);
        sock.write(body);
      });
      let seen = '';
      sock.on('data', (d) => {
        seen += d.toString('latin1', 0, 64);
        const eol = seen.indexOf('\r\n');
        if (eol >= 0) finish(seen.slice(0, eol)); // status line: the server has the whole request
      });
      sock.on('error', (e) => finish(e?.message ?? 'error'));
      sock.on('close', () => finish('closed'));
    } catch (e) {
      finish(e?.message ?? 'error');
    }
  });
}

const owned = (st) => process.platform === 'win32' || typeof process.getuid !== 'function' || st.uid === process.getuid();

function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/** True when the directory holds nothing but entries agents create themselves (work/, .gitignore). */
function isAgentOnlyDir(dir) {
  try {
    return readdirSync(dir).every((n) => n === 'work' || n === '.gitignore');
  } catch {
    return false;
  }
}

function canonicalDir(dir) {
  try {
    if (!dir || !statSync(dir).isDirectory()) return '';
    return realpathSync.native(dir);
  } catch {
    return '';
  }
}

/** True when .tagconn (opened without following symlinks) is the directory `expected` lstat-ed.
 *  win32 cannot open a directory, and its ino is not reliable, so it relies on the lstat alone. */
function sameDirInode(dir, expected) {
  if (process.platform === 'win32') return true;
  try {
    const fd = openSync(dir, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_DIRECTORY ?? 0));
    try {
      return sameInode(expected, fstatSync(fd));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function writeReadme(dir, data) {
  writeFileSync(path.join(dir, 'README.md'), data, { flag: fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0) });
}

/** The detached attribution step. Every guard mirrors the sh subshell. */
async function attribution(cfg, configDir, sid) {
  const platform = process.platform;
  const rd = canonicalDir(process.env.CLAUDE_PROJECT_DIR);
  if (!rd) return;
  // L5: fail closed. Every home candidate that resolves counts; none resolving skips attribution.
  const homes = [process.env.HOME, process.env.USERPROFILE, homedir()].map(canonicalDir).filter(Boolean);
  const guard = homeGuard(rd, homes, platform);
  if (guard.skip) return;
  // L4: win32 cannot check ownership (owned() is always true there), so limit to %USERPROFILE%.
  if (platform === 'win32' && winProjectOutsideUserProfile(rd, canonicalDir(process.env.USERPROFILE))) return;
  const tpl = path.join(configDir, 'attribution-README.md');

  // README write: git repo we own, never $HOME or a root, never touch an existing .tagconn.
  try {
    const rdStat = statSync(rd);
    if (
      cfg.attributionReadme &&
      owned(rdStat) &&
      existsSync(path.join(rd, '.git')) &&
      !guard.isHome &&
      !isFsRoot(rd, platform)
    ) {
      const t = path.join(rd, '.tagconn');
      const tplStat = statSync(tpl, { throwIfNoEntry: false });
      if (tplStat?.isFile() && tplStat.size <= README_MAX_BYTES) {
        const existing = lstatOrNull(t);
        if (!existing) {
          const data = readFileSync(tpl);
          mkdirSync(t); // single level, not recursive: fails if it appeared meanwhile
          const st = lstatOrNull(t);
          if (st?.isDirectory() && !st.isSymbolicLink() && sameDirInode(t, st)) {
            writeReadme(t, data); // never overwrites
          }
        } else if (existing.isDirectory() && !existing.isSymbolicLink() && owned(existing) && isAgentOnlyDir(t)) {
          // Agents may create .tagconn/work and .gitignore before the hook runs; that is not an
          // opt-out (an opt-out is a plain FILE named .tagconn). Add only README.md, never overwrite.
          if (sameDirInode(t, existing)) writeReadme(t, readFileSync(tpl));
        }
      }
    }
  } catch (e) {
    dbg('readme step failed', e?.message ?? e);
  }

  // Profile import: regular, non-symlink, owned .tagconn/office.json in a same kind of dir.
  try {
    if (!cfg.attributionImport || !sid) return;
    const t = path.join(rd, '.tagconn');
    const ts = lstatOrNull(t);
    if (!ts || !ts.isDirectory() || ts.isSymbolicLink() || !owned(ts)) return;
    const f = path.join(t, 'office.json');
    const fs0 = lstatOrNull(f);
    if (!fs0 || !fs0.isFile() || fs0.isSymbolicLink() || !owned(fs0)) return; // isFile: never open a FIFO
    // O_NOFOLLOW/O_NONBLOCK where defined (not on win32); the fstat must be the object we lstat-ed.
    const fd = openSync(f, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
    let raw;
    try {
      const fst = fstatSync(fd);
      if (!fst.isFile() || !sameInode(fs0, fst)) return;
      const buf = Buffer.alloc(IMPORT_MAX_BYTES + 1);
      const n = readSync(fd, buf, 0, buf.length, 0); // read ONCE (no measure-then-read window)
      if (n <= 0 || n > IMPORT_MAX_BYTES) return;
      raw = buf.subarray(0, n);
    } finally {
      closeSync(fd);
    }
    await post(`${cfg.base}/api/attribution/import`, cfg.token, raw, { 'x-tagconn-session-id': sid });
  } catch (e) {
    dbg('import step failed', e?.message ?? e);
  }
}

async function main() {
  const isChild = process.argv[2] === '--attribution';
  const failsafe = setTimeout(() => process.exit(0), isChild ? 2500 : FAILSAFE_MS);

  if (isChild) {
    const { hookJson, configDir } = resolveConfigPaths(process.env, process.platform, homedir(), path.dirname(fileURLToPath(import.meta.url)), existsSync);
    const cfg = loadConfig(hookJson);
    if (cfg) await attribution(cfg, configDir, sanitizeSessionId(process.env.TAGCONN_HOOK_SID ?? ''));
    clearTimeout(failsafe);
    return;
  }

  // Always read stdin fully first, even if we bail out below.
  const buf = await readStdin();

  if (process.env.OFFICE_DISABLED === '1') return;
  if (process.env.TAGCONN_RUN_KIND === 'receptionist') return;
  if (!buf) return;

  const { hookJson, configDir } = resolveConfigPaths(process.env, process.platform, homedir(), path.dirname(fileURLToPath(import.meta.url)), existsSync);
  const cfg = loadConfig(hookJson);
  if (!cfg) return dbg('no usable config at', hookJson);

  const headers = isRunIdHint(process.env.TAGCONN_RUN_ID) ? { 'x-tagconn-run-id': process.env.TAGCONN_RUN_ID } : {};
  await post(`${cfg.base}/api/hooks`, cfg.token, buf, headers);

  const body = buf.length <= SESSION_START_SCAN_MAX ? buf.toString('utf8') : '';
  if (body && process.env.TAGCONN_ATTRIBUTION !== 'off' && isSessionStart(body)) {
    try {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--attribution'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...childEnv(process.env), TAGCONN_HOOK_SID: sanitizeSessionId(lastStringField(body, 'session_id')) },
      });
      child.on('error', () => {});
      child.unref();
    } catch (e) {
      dbg('attribution spawn failed', e?.message ?? e);
    }
  }
  clearTimeout(failsafe);
}

/** L2: the detached child must not inherit interpreter-altering env. */
export function childEnv(env) {
  const e = { ...env };
  delete e.NODE_OPTIONS;
  delete e.NODE_TLS_REJECT_UNAUTHORIZED;
  return e;
}

const isEntry = (() => {
  try {
    return !!process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isEntry) {
  process.on('uncaughtException', (e) => {
    dbg('uncaught', e?.message ?? e);
    process.exit(0);
  });
  process.on('unhandledRejection', (e) => {
    dbg('unhandled', e?.message ?? e);
    process.exit(0);
  });
  try {
    await main();
  } catch (e) {
    dbg('error', e?.message ?? e);
  }
  process.exit(0);
}
