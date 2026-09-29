import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathFor, resolveSetupPaths } from './paths.ts';
import { touch, type SetupContext } from './context.ts';

// The node hook is registered in exec form with an absolute node path (M1 of the wave 1 review). That path
// must outlive the shell that started the installer and must not be replaceable by another user, so a node
// that lives somewhere transient or shared is copied to a stable, user-owned location first.

export interface NodeStabilizeOptions {
  /** Directories that count as transient (default: os.tmpdir(), $TMPDIR/$TEMP/$TMP, /tmp, /var/tmp, /dev/shm). Tests override it. */
  tempRoots?: string[];
  /** Where the stable copy goes (default: see `defaultNodeDir`). */
  nodeDir?: string;
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

/** Why this node path must not be registered as it is (null: it is fine). Checks the path as given and its realpath. */
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
  if (ctx.platform !== 'win32') {
    // Any ancestor (or the file) that group/others can write to lets another user swap the binary.
    // A sticky directory (like /tmp) stops others from replacing our entries, so it is tolerated.
    const p = pathFor(ctx.platform);
    for (let cur = real; ; cur = p.dirname(cur)) {
      let mode: number;
      try {
        mode = statSync(cur).mode;
      } catch {
        break;
      }
      const isDir = (mode & 0o170000) === 0o040000;
      if (mode & 0o022 && !(isDir && mode & 0o1000)) return `${cur} is writable by other users`;
      if (p.dirname(cur) === cur) break;
    }
  }
  return null;
}

/** `<node> --version` (the running node answers from process.version without a spawn). */
function versionOf(ctx: SetupContext, nodePath: string): string | null {
  const res = ctx.exec(nodePath, ['--version'], { timeoutMs: 10_000 });
  return !res.error && res.status === 0 ? res.stdout.trim() || null : null;
}

/**
 * Returns the node path to register. A transient or shared-writable node is copied to a stable user-owned
 * location (idempotent: re-copied only if its size or `--version` differs) and that copy is returned.
 * A node that does not exist on disk is passed through untouched (doctor flags it later).
 */
export function stabilizeNodePath(ctx: SetupContext, nodePath: string, opts: NodeStabilizeOptions = {}): string {
  if (!existsSync(nodePath)) return nodePath;
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

  const srcSize = statSync(nodePath).size;
  const upToDate =
    existsSync(dest) && statSync(dest).size === srcSize && (() => {
      const want = versionOf(ctx, nodePath);
      return want === null || want === versionOf(ctx, dest);
    })();
  if (upToDate) {
    ctx.log(`  node at ${dest} is up to date (${nodePath} is unsafe to register: ${reason})`);
    return dest;
  }

  const existedBefore = existsSync(dir);
  mkdirSync(dir, { recursive: true });
  if (ctx.platform !== 'win32' && !existedBefore) chmodSync(dir, 0o700);
  const tmp = `${dest}.tagconn-tmp-${process.pid}`;
  try {
    copyFileSync(nodePath, tmp);
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
  touch(ctx, dest);
  ctx.log(`  copied node to ${dest} (${nodePath} is unsafe to register: ${reason})`);
  return dest;
}
