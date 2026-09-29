import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathFor, resolveSetupPaths } from './paths.ts';
import { touch, type SetupContext } from './context.ts';
import { currentWindowsUser, isCurrentUser, parseIcaclsAces, systemBin, type WindowsUser } from './secrets.ts';

// The node hook is registered in exec form with an absolute node path (M1 of the wave 1 review). That path
// must outlive the shell that started the installer and must not be replaceable by another user, so a node
// that lives somewhere transient or shared is copied to a stable, user-owned location first.

export interface NodeStabilizeOptions {
  /** Directories that count as transient (default: os.tmpdir(), $TMPDIR/$TEMP/$TMP, /tmp, /var/tmp, /dev/shm). Tests override it. */
  tempRoots?: string[];
  /** Where the stable copy goes (default: see `defaultNodeDir`). */
  nodeDir?: string;
  /** The uid that may own the node and its parent dirs besides root (default: process.getuid()). Tests override it. */
  uid?: number;
}

/** `%LOCALAPPDATA%\tagconn\node` on win32, `<XDG data>/tagconn/node` (~/.local/share/tagconn/node) elsewhere. */
export function defaultNodeDir(ctx: SetupContext): string {
  const p = pathFor(ctx.platform);
  const paths = resolveSetupPaths({ platform: ctx.platform, env: ctx.env });
  return ctx.platform === 'win32' ? p.join(p.dirname(paths.data), 'node') : p.join(paths.data, 'node');
}

function defaultTempRoots(ctx: SetupContext): string[] {
  const roots = [tmpdir(), ctx.env.TMPDIR, ctx.env.TEMP, ctx.env.TMP];
  if (ctx.platform !== 'win32') roots.push('/tmp', '/var/tmp', '/dev/shm');
  return roots.filter((r): r is string => Boolean(r));
}

function isUnder(path: string, root: string, platform: NodeJS.Platform): boolean {
  const p = pathFor(platform);
  const norm = (x: string) => (platform === 'win32' ? p.resolve(x).toLowerCase() : p.resolve(x));
  const rel = p.relative(norm(root), norm(path));
  return rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel);
}

/** Why this node path is transient (temp dir, AppImage mount, fnm shell; null: it is not). Checks the path as given and its realpath. */
export function transientNodeReason(ctx: SetupContext, nodePath: string, opts: NodeStabilizeOptions = {}): string | null {
  const roots = opts.tempRoots ?? defaultTempRoots(ctx);
  let real = nodePath;
  try {
    real = realpathSync(nodePath);
  } catch {
    // not on disk (yet): only the string checks below apply
  }
  for (const candidate of new Set([nodePath, real])) {
    if (roots.some((r) => isUnder(candidate, r, ctx.platform))) return 'it is under a temporary directory';
    // AppImage mounts (/tmp/.mount_xxx) and fnm's per-shell symlink dirs vanish with their session.
    if (/[\\/]\.mount_[^\\/]+[\\/]/.test(candidate)) return 'it is inside an AppImage mount';
    if (/[\\/]fnm_multishells?[\\/]/i.test(candidate)) return 'it is an fnm per-shell path';
  }
  return null;
}

const SWAP_RIGHTS = new Set(['F', 'M', 'DC', 'DE', 'WDAC', 'WO', 'GA', 'GW']);
// On the binary and its own folder even a plain write (replace the file, plant a DLL next to it) is enough.
const LEAF_RIGHTS = new Set([...SWAP_RIGHTS, 'W', 'WD', 'AD', 'WA', 'WEA']);
const ACE_NOISE = new Set(['I', 'OI', 'CI', 'IO', 'NP', 'DENY']);
// English names and SIDs of the principals that may write to a system folder. An unresolvable principal
// (or a localized name we do not know) fails closed, and the error points at tagconn's bundled node.
const TRUSTED_WINDOWS = /^(?:nt authority\\system|system|builtin\\administrators|administrators|nt service\\trustedinstaller|s-1-5-18|s-1-5-32-544|s-1-5-80-\d+(?:-\d+)*)$/i;

function windowsWritableReason(ctx: SetupContext, nodePath: string): string | null {
  const user: WindowsUser | null = currentWindowsUser(ctx.env, ctx.exec);
  if (!user) return 'the current Windows user could not be determined, so the folder permissions of the node cannot be verified';
  const p = pathFor('win32');
  const chain = [nodePath];
  for (let cur = p.dirname(nodePath); ; cur = p.dirname(cur)) {
    chain.push(cur);
    if (p.dirname(cur) === cur) break;
  }
  for (const [i, cur] of chain.entries()) {
    const res = ctx.exec(systemBin(ctx.env, 'icacls'), [cur], { timeoutMs: 15_000 });
    if (res.error || res.status !== 0) return `the permissions of ${cur} could not be read (icacls failed), so the node cannot be verified`;
    const rights = i <= 1 ? LEAF_RIGHTS : SWAP_RIGHTS;
    for (const ace of parseIcaclsAces(res.stdout, cur)) {
      const flags = ace.flags.map((f) => f.toUpperCase());
      if (flags.includes('DENY') || (i > 0 && flags.includes('IO'))) continue; // inherit-only ACEs do not apply to the folder itself
      if (isCurrentUser(ace.principal, user) || TRUSTED_WINDOWS.test(ace.principal.replace(/^\*/, ''))) continue;
      if (flags.some((f) => !ACE_NOISE.has(f) && rights.has(f))) return `${cur} is writable by ${ace.principal}`;
    }
  }
  return null;
}

/**
 * Why another user could swap this node binary (null: nobody else can). POSIX: the file and every component of its
 * real path must be owned by root or the current user and not group/world-writable; a sticky world-writable dir
 * (like /tmp) is tolerated only when root or the current user owns it. win32: the ACL of the binary and of every
 * parent folder up to the drive root (`icacls`) may grant write access to the current user, SYSTEM,
 * Administrators and TrustedInstaller only.
 */
export function nodeWritableReason(ctx: SetupContext, nodePath: string, opts: NodeStabilizeOptions = {}): string | null {
  let real = nodePath;
  try {
    real = realpathSync(nodePath);
  } catch {
    // not on disk: nothing to check
  }
  if (ctx.platform === 'win32') return windowsWritableReason(ctx, real);
  const uid = opts.uid ?? process.getuid?.();
  const p = pathFor(ctx.platform);
  for (let cur = real; ; cur = p.dirname(cur)) {
    let st;
    try {
      st = statSync(cur);
    } catch {
      break;
    }
    if (st.uid !== 0 && uid !== undefined && st.uid !== uid) return `${cur} is owned by another user (uid ${st.uid})`;
    const isDir = (st.mode & 0o170000) === 0o040000;
    if (st.mode & 0o022 && !(isDir && st.mode & 0o1000)) return `${cur} is writable by other users`;
    if (p.dirname(cur) === cur) break;
  }
  return null;
}

/** `<node> --version`: spawns the binary (even the running node is executed, nothing is answered from process.version). */
function versionOf(ctx: SetupContext, nodePath: string): string | null {
  const res = ctx.exec(nodePath, ['--version'], { timeoutMs: 10_000 });
  return !res.error && res.status === 0 ? res.stdout.trim() || null : null;
}

const UNSAFE_HELP = "Install tagconn's bundled node (the desktop app ships one), or move node to a folder only you can write to and pass --node-path.";

/** Opens the source once: the running node via /proc/self/exe on Linux, else the realpath. Everything after reads this fd. */
function openNodeSource(ctx: SetupContext, nodePath: string, uid: number | undefined): number {
  let real = nodePath;
  try {
    real = realpathSync(nodePath);
  } catch {
    // opened below, which reports the error
  }
  let isSelf = false;
  try {
    isSelf = ctx.platform === 'linux' && real === realpathSync(process.execPath);
  } catch {
    // not the running node
  }
  const fd = openSync(isSelf ? '/proc/self/exe' : real, constants.O_RDONLY | (ctx.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`${nodePath} is not a regular file`);
    if (ctx.platform !== 'win32') {
      if (st.uid !== 0 && uid !== undefined && st.uid !== uid) throw new Error(`${nodePath} is owned by another user. ${UNSAFE_HELP}`);
      if (st.mode & 0o022) throw new Error(`${nodePath} is writable by other users. ${UNSAFE_HELP}`);
    }
  } catch (err) {
    closeSync(fd);
    throw err;
  }
  return fd;
}

/** User-only folder: 0700 on POSIX, `icacls /inheritance:r /grant:r *<SID>:(OI)(CI)F` on win32. */
function restrictDir(ctx: SetupContext, dir: string): void {
  if (ctx.platform !== 'win32') {
    chmodSync(dir, 0o700);
    return;
  }
  const user = currentWindowsUser(ctx.env, ctx.exec);
  if (!user) throw new Error(`Could not restrict ${dir} to your user (whoami failed).`);
  const res = ctx.exec(systemBin(ctx.env, 'icacls'), [dir, '/inheritance:r', '/grant:r', `*${user.sid}:(OI)(CI)F`], { timeoutMs: 15_000 });
  if (res.error || res.status !== 0) {
    throw new Error(`Could not restrict ${dir} to your user (${res.error?.message ?? (res.stderr.trim() || `icacls exit ${res.status}`)}).`);
  }
}

function copyFd(srcFd: number, tmp: string, mode: number): void {
  const out = openSync(tmp, 'wx', mode);
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (let n = readSync(srcFd, buf, 0, buf.length, null); n > 0; n = readSync(srcFd, buf, 0, buf.length, null)) {
      for (let off = 0; off < n; ) off += writeSync(out, buf, off, n - off);
    }
  } finally {
    closeSync(out);
  }
}

/**
 * Returns the node path to register. A node that others can write to is refused (it may already have been
 * swapped; copying it would launder that). A transient node is copied to a stable user-only location
 * (idempotent: re-copied only if its size or `--version` differs) and that copy is returned. The copy is read
 * from one opened fd, never re-opened by path. A node that does not exist on disk is passed through untouched
 * (doctor flags it later).
 */
export function stabilizeNodePath(ctx: SetupContext, nodePath: string, opts: NodeStabilizeOptions = {}): string {
  if (!existsSync(nodePath)) return nodePath;
  const unsafe = nodeWritableReason(ctx, nodePath, opts);
  if (unsafe) throw new Error(`Refusing to register node at ${nodePath}: ${unsafe}, so another user could replace it. ${UNSAFE_HELP}`);
  const reason = transientNodeReason(ctx, nodePath, opts);
  if (!reason) return nodePath;

  const p = pathFor(ctx.platform);
  const dir = opts.nodeDir ?? defaultNodeDir(ctx);
  const dest = p.join(dir, ctx.platform === 'win32' ? 'node.exe' : 'node');
  if (dest === nodePath) return nodePath;
  if (ctx.dryRun) {
    ctx.log(`  [dry-run] ${nodePath} is unsafe to register (${reason}); would copy it to ${dest}`);
    return dest;
  }

  const uid = opts.uid ?? process.getuid?.();
  const srcFd = openNodeSource(ctx, nodePath, uid);
  try {
    const srcSize = fstatSync(srcFd).size;
    const upToDate =
      existsSync(dest) && statSync(dest).size === srcSize && (() => {
        const want = versionOf(ctx, nodePath);
        return want === null || want === versionOf(ctx, dest);
      })();
    if (upToDate) {
      ctx.log(`  node at ${dest} is up to date (${nodePath} is unsafe to register: ${reason})`);
      return dest;
    }

    mkdirSync(dir, { recursive: true });
    restrictDir(ctx, dir);
    const tmp = `${dest}.tagconn-tmp-${process.pid}`;
    try {
      copyFd(srcFd, tmp, 0o755);
      if (ctx.platform !== 'win32') chmodSync(tmp, 0o755);
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { force: true });
      if (existsSync(dest)) {
        // e.g. Windows: the previous copy is in use by a running hook. Keep it rather than fail the install.
        ctx.warn(`could not refresh ${dest} (${(err as Error).message}); keeping the existing copy`);
        return dest;
      }
      throw new Error(`Could not copy node to ${dest} (${(err as Error).message}). Pass --node-path to a node in a stable, user-owned folder.`);
    }
  } finally {
    closeSync(srcFd);
  }
  touch(ctx, dest);
  ctx.log(`  copied node to ${dest} (${nodePath} is unsafe to register: ${reason})`);
  return dest;
}
