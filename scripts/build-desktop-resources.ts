// Assembles apps/desktop/src-tauri/resources/ (what the packaged app runs) and the bundled node sidecar
// (src-tauri/binaries/tagconn-node-<triple>[.exe]) from the built workspace. Run after `pnpm build`:
//
//   node scripts/build-desktop-resources.ts --target x86_64-unknown-linux-gnu [--cache-dir DIR] [--node-version 24.21.0]
//                                           [--out DIR] [--binaries-dir DIR] [--skip-node]
//
// Layout (what TAGCONN_BUNDLE_DIR points at; apps/supervisor/src/paths.ts):
//   supervisor/supervisor.js   server/main.js + server/node_modules   runner/main.js + runner/node_modules
//   web/   hook/office-hook.{mjs,sh}   agent-templates/{roles,skills,attribution}   docker-compose.yml
// better-sqlite3 13 is N-API with prebuilt binaries for every platform, so its node ABI never differs; the
// script keeps only the target's prebuild. The node download must match the SHA-256 pinned in PINNED_NODE_SHA256
// (and, as a second layer, the published SHASUMS256.txt). Node is bundled under its own name (tagconn-node) so an
// installed package never ships /usr/bin/node. `pnpm deploy` honours the lockfile (inject-workspace-packages is set
// in the staged workspace only) and every deployed package is then checked against pnpm-lock.yaml.
//   node scripts/build-desktop-resources.ts --verify-deploy <node_modules dir> [--lockfile pnpm-lock.yaml]
// Node builtins only, erasable TS (runs as `node scripts/build-desktop-resources.ts`).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_VERSION = '24.21.0';
export const NODE_DIST_BASE = 'https://nodejs.org/dist';

export interface NodeDist {
  triple: string;
  /** Node's platform-arch naming, e.g. win-x64. */
  slug: string;
  archive: string;
  ext: 'zip' | 'tar.xz';
  /** Path of the node executable inside the archive. */
  binInArchive: string;
  /** File name under src-tauri/binaries (Tauri externalBin: tagconn-node-<triple>[.exe]). */
  sidecar: string;
  /** better-sqlite3 prebuild to keep, e.g. win32-x64.node. */
  prebuild: string;
}

const TRIPLES: Record<string, { os: 'win' | 'linux'; arch: 'x64' | 'arm64' }> = {
  'x86_64-pc-windows-msvc': { os: 'win', arch: 'x64' },
  'aarch64-pc-windows-msvc': { os: 'win', arch: 'arm64' },
  'x86_64-unknown-linux-gnu': { os: 'linux', arch: 'x64' },
  'aarch64-unknown-linux-gnu': { os: 'linux', arch: 'arm64' },
};

export const supportedTriples = (): string[] => Object.keys(TRIPLES);

/** Rust target triple -> the official node distribution to bundle. Throws on an unsupported triple. */
export function nodeDistFor(triple: string, version: string = NODE_VERSION): NodeDist {
  const t = Object.hasOwn(TRIPLES, triple) ? TRIPLES[triple] : undefined;
  if (!t) throw new Error(`unsupported target "${triple}" (supported: ${supportedTriples().join(', ')})`);
  const slug = `${t.os}-${t.arch}`;
  const win = t.os === 'win';
  const base = `node-v${version}-${slug}`;
  return {
    triple,
    slug,
    archive: `${base}.${win ? 'zip' : 'tar.xz'}`,
    ext: win ? 'zip' : 'tar.xz',
    binInArchive: win ? `${base}/node.exe` : `${base}/bin/node`,
    sidecar: `tagconn-node-${triple}${win ? '.exe' : ''}`,
    prebuild: `${win ? 'win32' : 'linux'}-${t.arch}.node`,
  };
}

/** SHA-256 of the official node archives, per version, from https://nodejs.org/dist/v<version>/SHASUMS256.txt. */
export const PINNED_NODE_SHA256: Record<string, Record<string, string>> = {
  '24.21.0': {
    'node-v24.21.0-win-x64.zip': '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
    'node-v24.21.0-win-arm64.zip': '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921',
    'node-v24.21.0-linux-x64.tar.xz': 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
    'node-v24.21.0-linux-arm64.tar.xz': '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2',
  },
};

/** The pinned digest of a node archive, or undefined when that version/archive has no pin. */
export function pinnedSha256(version: string, archive: string): string | undefined {
  const perVersion = Object.hasOwn(PINNED_NODE_SHA256, version) ? PINNED_NODE_SHA256[version] : undefined;
  return perVersion && Object.hasOwn(perVersion, archive) ? perVersion[archive] : undefined;
}

/** Parses a SHASUMS256.txt ("<sha256>  <file>" per line) into file -> lowercase hex digest. */
export function parseShasums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (m?.[1] && m[2]) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** The name@version keys of the `packages:` section of a pnpm-lock.yaml (lockfileVersion 9). */
export function parseLockfilePackages(text: string): Set<string> {
  const out = new Set<string>();
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = line.trimEnd() === 'packages:';
      continue;
    }
    if (!inPackages) continue;
    const m = /^ {2}(?:'([^']+)'|"([^"]+)"|([^\s'"][^\s]*)):\s*$/.exec(line);
    const key = m?.[1] ?? m?.[2] ?? m?.[3];
    if (key) out.add(key);
  }
  return out;
}

export interface DeployedPackage {
  name: string;
  version: string;
  dir: string;
}

/** Deployed packages whose name@version is not in the lockfile (workspace packages in `ignore` are skipped). */
export function lockfileViolations(deployed: DeployedPackage[], lock: Set<string>, ignore: Set<string> = new Set()): string[] {
  return deployed.filter((p) => !ignore.has(p.name) && !lock.has(`${p.name}@${p.version}`)).map((p) => `${p.name}@${p.version} (${p.dir})`);
}

/** Every package under a node_modules dir (hoisted nesting and the .pnpm virtual store included), read from package.json. */
export function collectDeployedPackages(nm: string): DeployedPackage[] {
  const out: DeployedPackage[] = [];
  const seen = new Set<string>();
  const isDir = (p: string) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const readPkg = (dir: string) => {
    try {
      const j = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      return typeof j.name === 'string' && typeof j.version === 'string' ? { name: j.name, version: j.version } : null;
    } catch {
      return null;
    }
  };
  const visitPkg = (dir: string) => {
    const real = realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    const pkg = readPkg(dir);
    if (pkg) out.push({ ...pkg, dir });
    walk(join(dir, 'node_modules'));
  };
  function walk(dir: string): void {
    if (!isDir(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === '.bin' || !isDir(p)) continue;
      if (name === '.pnpm') {
        for (const store of readdirSync(p)) walk(join(p, store, 'node_modules'));
      } else if (name.startsWith('@')) {
        for (const sub of readdirSync(p)) if (isDir(join(p, sub))) visitPkg(join(p, sub));
      } else if (!name.startsWith('.')) {
        visitPkg(p);
      }
    }
  }
  walk(nm);
  return out;
}

/** Throws unless every package under `nm` is pinned by the lockfile at `lockfile`. Returns how many were checked. */
export function verifyDeploy(nm: string, lockfile: string, ignore: Set<string> = new Set()): number {
  const deployed = collectDeployedPackages(nm);
  if (deployed.length === 0) throw new Error(`no packages found under ${nm}`);
  const bad = lockfileViolations(deployed, parseLockfilePackages(readFileSync(lockfile, 'utf8')), ignore);
  if (bad.length > 0) throw new Error(`${bad.length} deployed package(s) are not in ${lockfile}:\n  ${bad.join('\n  ')}`);
  return deployed.length;
}

/** Repo-relative source -> resource-relative destination. `web` etc. are directories, the rest single files. */
export interface CopyStep {
  from: string;
  to: string;
}

export function copyPlan(root: string = ROOT): CopyStep[] {
  const p = (...s: string[]) => join(root, ...s);
  return [
    { from: p('apps', 'supervisor', 'dist', 'supervisor.js'), to: join('supervisor', 'supervisor.js') },
    { from: p('apps', 'server', 'dist', 'main.js'), to: join('server', 'main.js') },
    { from: p('apps', 'runner', 'dist', 'main.js'), to: join('runner', 'main.js') },
    { from: p('apps', 'web', 'dist'), to: 'web' },
    { from: p('packages', 'hook', 'office-hook.mjs'), to: join('hook', 'office-hook.mjs') },
    { from: p('packages', 'hook', 'office-hook.sh'), to: join('hook', 'office-hook.sh') },
    { from: p('packages', 'agent-templates', 'roles'), to: join('agent-templates', 'roles') },
    { from: p('packages', 'agent-templates', 'skills'), to: join('agent-templates', 'skills') },
    { from: p('packages', 'agent-templates', 'attribution'), to: join('agent-templates', 'attribution') },
    { from: p('apps', 'supervisor', 'compose', 'docker-compose.yml'), to: 'docker-compose.yml' },
  ];
}

/** Production deploys that get a node_modules next to their bundle: workspace filter -> resource dir. */
export const DEPLOYS = [
  { filter: '@tagconn/server', to: 'server' },
  { filter: '@tagconn/runner', to: 'runner' },
] as const;

export interface Args {
  target: string;
  cacheDir: string;
  nodeVersion: string;
  out: string;
  binariesDir: string;
  skipNode: boolean;
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): Args {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--skip-node') {
      bools.add('skip-node');
    } else if (a.startsWith('--') && ['target', 'cache-dir', 'node-version', 'out', 'binaries-dir'].includes(a.slice(2))) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      flags.set(a.slice(2), v);
    } else {
      throw new Error(`unknown argument "${a}"`);
    }
  }
  const target = flags.get('target');
  if (!target) throw new Error(`--target <triple> is required (${supportedTriples().join(' | ')})`);
  nodeDistFor(target); // validates
  const version = flags.get('node-version') ?? NODE_VERSION;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`--node-version "${version}" is not X.Y.Z`);
  const tauri = join(ROOT, 'apps', 'desktop', 'src-tauri');
  return {
    target,
    cacheDir: resolve(flags.get('cache-dir') ?? env.TAGCONN_DESKTOP_CACHE ?? join(tmpdir(), 'tagconn-desktop-cache')),
    nodeVersion: version,
    out: resolve(flags.get('out') ?? join(tauri, 'resources')),
    binariesDir: resolve(flags.get('binaries-dir') ?? join(tauri, 'binaries')),
    skipNode: bools.has('skip-node'),
  };
}

const log = (msg: string) => console.log(`[desktop-resources] ${msg}`);
const sha256File = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

async function download(url: string, dest: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new Error(`cannot download ${url}: ${(err as Error).message}`);
  }
  if (!res.ok) throw new Error(`cannot download ${url}: HTTP ${res.status}`);
  const tmp = `${dest}.part`;
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  renameSync(tmp, dest);
}

/** Downloads (or reuses from the cache) the node archive: pinned SHA-256 first, SHASUMS256.txt as a second layer. */
async function fetchNodeArchive(dist: NodeDist, version: string, cacheDir: string): Promise<string> {
  const pinned = pinnedSha256(version, dist.archive);
  if (!pinned) throw new Error(`no pinned SHA-256 for ${dist.archive} (node ${version}): add it to PINNED_NODE_SHA256 from the official SHASUMS256.txt`);
  mkdirSync(cacheDir, { recursive: true });
  const base = `${NODE_DIST_BASE}/v${version}`;
  const sumsPath = join(cacheDir, `SHASUMS256-v${version}.txt`);
  try {
    await download(`${base}/SHASUMS256.txt`, sumsPath);
  } catch (err) {
    if (!existsSync(sumsPath)) throw err;
    log(`${(err as Error).message}; using the cached SHASUMS256.txt`);
  }
  const published = parseShasums(readFileSync(sumsPath, 'utf8')).get(dist.archive);
  if (!published) throw new Error(`SHASUMS256.txt for node v${version} has no entry for ${dist.archive}`);
  if (published !== pinned) throw new Error(`SHASUMS256.txt says ${published} for ${dist.archive} but ${pinned} is pinned: refusing to continue`);
  const archive = join(cacheDir, dist.archive);
  if (existsSync(archive) && sha256File(archive) === pinned) {
    log(`node archive cached: ${archive}`);
    return archive;
  }
  log(`downloading ${dist.archive}`);
  await download(`${base}/${dist.archive}`, archive);
  const actual = sha256File(archive);
  if (actual !== pinned) {
    rmSync(archive, { force: true });
    throw new Error(`checksum mismatch for ${dist.archive}: expected ${pinned}, got ${actual} (the download was discarded)`);
  }
  return archive;
}

function extractArchive(archive: string, ext: NodeDist['ext'], into: string): void {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  const r =
    ext === 'zip' && process.platform === 'win32'
      ? // -Command doesn't bind extra argv to $args, so the paths travel in env vars (never parsed as code).
        spawnSync(
          join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:TAGCONN_ARCHIVE -DestinationPath $env:TAGCONN_DEST -Force'],
          { stdio: 'inherit', env: { ...process.env, TAGCONN_ARCHIVE: archive, TAGCONN_DEST: into } },
        )
      : spawnSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' });
  if (r.error) throw new Error(`cannot extract ${basename(archive)}: ${r.error.message} (need ${ext === 'zip' ? 'PowerShell or bsdtar' : 'tar with xz'})`);
  if (r.status !== 0) throw new Error(`extracting ${basename(archive)} failed (exit ${r.status})`);
}

/** Puts the verified node at binaries/tagconn-node-<triple>[.exe]. Idempotent: a marker records what is installed. */
async function installNode(args: Args): Promise<string> {
  const dist = nodeDistFor(args.target, args.nodeVersion);
  const dest = join(args.binariesDir, dist.sidecar);
  const marker = `${dest}.version`;
  const archive = await fetchNodeArchive(dist, args.nodeVersion, args.cacheDir);
  const stamp = `${args.nodeVersion} ${sha256File(archive)}`;
  if (existsSync(dest) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === stamp) {
    log(`node sidecar up to date: ${dest}`);
    return dest;
  }
  const work = join(args.cacheDir, `extract-${args.target}`);
  extractArchive(archive, dist.ext, work);
  const exe = join(work, dist.binInArchive);
  if (!existsSync(exe)) throw new Error(`${dist.binInArchive} not found in ${dist.archive}`);
  mkdirSync(args.binariesDir, { recursive: true });
  cpSync(exe, dest);
  if (!dist.sidecar.endsWith('.exe')) chmodSync(dest, 0o755);
  writeFileSync(marker, `${stamp}\n`);
  rmSync(work, { recursive: true, force: true });
  log(`node ${args.nodeVersion} -> ${dest}`);
  return dest;
}

/** Quotes one argument for cmd.exe, which pnpm.cmd needs on Windows. Only fixed strings and paths go through it. */
const winQuote = (s: string) => `"${s.replace(/"/g, '""')}"`;

function pnpm(args: string[], cwd: string): void {
  const win = process.platform === 'win32';
  try {
    if (win) execFileSync(['pnpm', ...args.map(winQuote)].join(' '), { cwd, stdio: 'inherit', shell: true });
    else execFileSync('pnpm', args, { cwd, stdio: 'inherit' });
  } catch (err) {
    throw new Error(`pnpm ${args.join(' ')} failed: ${(err as Error).message}`);
  }
}

/**
 * A throwaway copy of the workspace inputs `pnpm deploy` needs (manifests, lockfile, the workspace packages).
 * `pnpm deploy` writes its own state file (production, hoisted, filtered) into the node_modules of the workspace
 * it runs in; running it in a copy keeps the repo's own node_modules untouched.
 */
function stageWorkspace(ws: string): void {
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']) {
    if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(ws, f));
  }
  // Only in this copy (the repo's install is unchanged): lets the non-legacy `pnpm deploy` run, which honours the lockfile.
  appendFileSync(join(ws, 'pnpm-workspace.yaml'), '\ninjectWorkspacePackages: true\n');
  const skip = (src: string) => !/[\\/](node_modules|dist|\.turbo)$/.test(src);
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(join(ROOT, group), { withFileTypes: true })) {
      if (!name.isDirectory()) continue;
      const from = join(ROOT, group, name.name);
      if (!existsSync(join(from, 'package.json'))) continue;
      // apps only need their manifest; packages are small and get copied into the deploy.
      if (group === 'apps') {
        mkdirSync(join(ws, group, name.name), { recursive: true });
        cpSync(join(from, 'package.json'), join(ws, group, name.name, 'package.json'));
      } else {
        cpSync(from, join(ws, group, name.name), { recursive: true, filter: skip });
      }
    }
  }
}

/** A flat (hoisted, symlink-free) production node_modules of one workspace app, minus what the target never loads. */
function deployProd(ws: string, filter: string, dir: string, dist: NodeDist): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dirname(dir), { recursive: true });
  // ignore-scripts: better-sqlite3 ships prebuilt N-API binaries, so no compiler is needed. No --legacy: that mode
  // ignores the lockfile (it resolved newer versions than locked); the plain deploy uses it, workspace deps injected.
  // hoisted: real directories (no .pnpm store or junctions), which Tauri's resource copy and the NSIS installer handle safely.
  pnpm(['--filter', filter, 'deploy', '--prod', '--config.node-linker=hoisted', '--config.verify-deps-before-run=false', '--config.ignore-scripts=true', dir], ws);
  const nm = join(dir, 'node_modules');
  if (!existsSync(nm)) throw new Error(`pnpm deploy for ${filter} produced no node_modules`);
  // .bin holds symlinks/shims; @tagconn/shared is bundled into the JS by tsup.
  rmSync(join(nm, '.bin'), { recursive: true, force: true });
  rmSync(join(nm, '@tagconn', 'shared'), { recursive: true, force: true });
  const sqlite = join(nm, 'better-sqlite3');
  if (existsSync(sqlite)) {
    const prebuilds = join(sqlite, 'prebuilds');
    if (!existsSync(join(prebuilds, dist.prebuild))) throw new Error(`better-sqlite3 has no ${dist.prebuild} prebuild for ${dist.triple}`);
    for (const f of readdirSync(prebuilds)) if (f !== dist.prebuild) rmSync(join(prebuilds, f), { force: true });
    for (const d of ['deps', 'src', 'build']) rmSync(join(sqlite, d), { recursive: true, force: true });
  }
  const checked = verifyDeploy(nm, join(ws, 'pnpm-lock.yaml'), workspaceNames(ws));
  log(`${filter}: ${checked} deployed packages all match pnpm-lock.yaml`);
  return nm;
}

/** Names of the workspace's own packages (never in the lockfile's `packages:`), read from the staged manifests. */
function workspaceNames(ws: string): Set<string> {
  const names = new Set<string>();
  for (const group of ['apps', 'packages']) {
    for (const d of readdirSync(join(ws, group), { withFileTypes: true })) {
      const f = join(ws, group, d.name, 'package.json');
      if (d.isDirectory() && existsSync(f)) names.add((JSON.parse(readFileSync(f, 'utf8')) as { name: string }).name);
    }
  }
  return names;
}

/** The repo's pnpm workspace state; a deploy that leaked into the real workspace changes it (production: true). */
const repoStateFile = () => join(ROOT, 'node_modules', '.pnpm-workspace-state-v1.json');
const repoState = (): string | null => (existsSync(repoStateFile()) ? readFileSync(repoStateFile(), 'utf8') : null);

function assemble(args: Args, dist: NodeDist): void {
  for (const step of copyPlan()) {
    if (!existsSync(step.from)) throw new Error(`${step.from} is missing: run \`pnpm build\` first`);
  }
  rmSync(args.out, { recursive: true, force: true });
  mkdirSync(args.out, { recursive: true });
  for (const step of copyPlan()) {
    const to = join(args.out, step.to);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(step.from, to, { recursive: true, filter: (src) => !src.endsWith('.map') });
  }
  // The bundles are ESM: a package.json next to each makes node treat main.js as a module regardless of detection.
  for (const dir of ['supervisor', 'server', 'runner']) {
    writeFileSync(join(args.out, dir, 'package.json'), `${JSON.stringify({ private: true, type: 'module' })}\n`);
  }
  const before = repoState();
  const ws = join(args.cacheDir, 'workspace');
  stageWorkspace(ws);
  for (const d of DEPLOYS) {
    const deployDir = join(args.cacheDir, `deploy-${d.to}`);
    log(`pnpm deploy ${d.filter} (in a staged copy of the workspace)`);
    const nm = deployProd(ws, d.filter, deployDir, dist);
    cpSync(nm, join(args.out, d.to, 'node_modules'), { recursive: true });
  }
  if (repoState() !== before) throw new Error(`${repoStateFile()} changed during the deploy: run \`pnpm install --frozen-lockfile\` to restore the workspace`);
}

export async function main(argv: string[]): Promise<void> {
  if (argv[0] === '--verify-deploy') {
    const dir = argv[1];
    if (!dir) throw new Error('--verify-deploy needs a node_modules directory');
    let lockfile = join(ROOT, 'pnpm-lock.yaml');
    if (argv[2] === '--lockfile' && argv[3]) lockfile = resolve(argv[3]);
    else if (argv.length > 2) throw new Error(`unknown argument "${argv[2]}"`);
    const ws = new Set<string>(['@tagconn/shared', '@tagconn/agent-templates']);
    log(`${verifyDeploy(resolve(dir), lockfile, ws)} packages under ${dir} all match ${lockfile}`);
    return;
  }
  const args = parseArgs(argv);
  const dist = nodeDistFor(args.target, args.nodeVersion);
  log(`target ${args.target}, node ${args.nodeVersion}, cache ${args.cacheDir}`);
  assemble(args, dist);
  log(`resources -> ${args.out}`);
  if (args.skipNode) log('--skip-node: not downloading the sidecar');
  else await installNode(args);
  log('done');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`build-desktop-resources failed: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
