// Assembles apps/desktop/src-tauri/resources/ (what the packaged app runs) and the bundled node sidecar
// (src-tauri/binaries/node-<triple>[.exe]) from the built workspace. Run after `pnpm build`:
//
//   node scripts/build-desktop-resources.ts --target x86_64-unknown-linux-gnu [--cache-dir DIR] [--node-version 24.21.0]
//                                           [--out DIR] [--binaries-dir DIR] [--skip-node]
//
// Layout (what TAGCONN_BUNDLE_DIR points at; apps/supervisor/src/paths.ts):
//   supervisor/supervisor.js   server/main.js + server/node_modules   runner/main.js + runner/node_modules
//   web/   hook/office-hook.{mjs,sh}   agent-templates/{roles,skills,attribution}   docker-compose.yml
// better-sqlite3 13 is N-API with prebuilt binaries for every platform, so its node ABI never differs; the
// script keeps only the target's prebuild. The node download is verified against the published SHASUMS256.txt.
// Node builtins only, erasable TS (runs as `node scripts/build-desktop-resources.ts`).
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  /** File name under src-tauri/binaries (Tauri externalBin: node-<triple>[.exe]). */
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
    sidecar: `node-${triple}${win ? '.exe' : ''}`,
    prebuild: `${win ? 'win32' : 'linux'}-${t.arch}.node`,
  };
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

/** Downloads (or reuses from the cache) the node archive, verified against SHASUMS256.txt. Returns its path. */
async function fetchNodeArchive(dist: NodeDist, version: string, cacheDir: string): Promise<string> {
  mkdirSync(cacheDir, { recursive: true });
  const base = `${NODE_DIST_BASE}/v${version}`;
  const sumsPath = join(cacheDir, `SHASUMS256-v${version}.txt`);
  try {
    await download(`${base}/SHASUMS256.txt`, sumsPath);
  } catch (err) {
    if (!existsSync(sumsPath)) throw err;
    log(`${(err as Error).message}; using the cached SHASUMS256.txt`);
  }
  const expected = parseShasums(readFileSync(sumsPath, 'utf8')).get(dist.archive);
  if (!expected) throw new Error(`SHASUMS256.txt for node v${version} has no entry for ${dist.archive}`);
  const archive = join(cacheDir, dist.archive);
  if (existsSync(archive) && sha256File(archive) === expected) {
    log(`node archive cached: ${archive}`);
    return archive;
  }
  log(`downloading ${dist.archive}`);
  await download(`${base}/${dist.archive}`, archive);
  const actual = sha256File(archive);
  if (actual !== expected) {
    rmSync(archive, { force: true });
    throw new Error(`checksum mismatch for ${dist.archive}: expected ${expected}, got ${actual} (the download was discarded)`);
  }
  return archive;
}

function extractArchive(archive: string, ext: NodeDist['ext'], into: string): void {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  const r =
    ext === 'zip' && process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', archive, into], { stdio: 'inherit' })
      : spawnSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' });
  if (r.error) throw new Error(`cannot extract ${basename(archive)}: ${r.error.message} (need ${ext === 'zip' ? 'PowerShell or bsdtar' : 'tar with xz'})`);
  if (r.status !== 0) throw new Error(`extracting ${basename(archive)} failed (exit ${r.status})`);
}

/** Puts the verified node at binaries/node-<triple>[.exe]. Idempotent: a marker records what is installed. */
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
  // ignore-scripts: better-sqlite3 ships prebuilt N-API binaries, so no compiler is needed. --legacy: workspace deps are
  // copied, not linked. hoisted: real directories (no .pnpm store or junctions), which
  // Tauri's resource copy and the NSIS installer handle safely.
  pnpm(['--filter', filter, 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', '--config.verify-deps-before-run=false', '--config.ignore-scripts=true', dir], ws);
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
  return nm;
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
