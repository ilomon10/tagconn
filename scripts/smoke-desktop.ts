// Smoke tests for the assembled desktop resources (scripts/build-desktop-resources.ts) and for an installed app.
// Everything runs against a sandbox (temp HOME, config and data dirs, a random port); nothing touches the real
// ~/.claude or ~/.config/tagconn.
//
//   node scripts/smoke-desktop.ts server --resources DIR --node NODE
//       Starts server/main.js from DIR with NODE: /api/health, the served web index, better-sqlite3 loads.
//   node scripts/smoke-desktop.ts rpc --resources DIR --node NODE
//       Runs supervisor/supervisor.js headless with a scripted JSON-RPC session: app.info, config.set,
//       service.start server, health + web index, service.stop; then asserts no leftover process.
//
// --resources is the folder holding supervisor/, server/, web/ (src-tauri/resources, or the installed app's dir).
// Node builtins only, erasable TS.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const fail = (msg: string): never => {
  throw new Error(msg);
};
const log = (msg: string) => console.log(`[smoke] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

interface Sandbox {
  dir: string;
  env: NodeJS.ProcessEnv;
}

/** A throwaway home: every path the supervisor and server derive lands inside it. */
function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'tagconn-smoke-'));
  const p = (...s: string[]) => join(dir, ...s);
  for (const d of ['home', 'config', 'state', 'data', 'claude']) mkdirSync(p(d), { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: p('home'),
    USERPROFILE: p('home'),
    APPDATA: p('config'),
    LOCALAPPDATA: p('state'),
    XDG_CONFIG_HOME: p('config'),
    XDG_STATE_HOME: p('state'),
    XDG_DATA_HOME: p('data'),
    TAGCONN_CONFIG_DIR: p('config', 'tagconn'),
    CLAUDE_CONFIG_DIR: p('claude'),
  };
  for (const k of Object.keys(env)) if (/^(OFFICE_|ANTHROPIC_)/.test(k)) delete env[k];
  return { dir, env };
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(250);
  }
  return fail(`timed out waiting for ${what}${last ? ` (last error: ${last})` : ''}`);
}

async function checkHttp(base: string): Promise<void> {
  const health = await waitFor('/api/health', async () => {
    const r = await fetch(`${base}/api/health`);
    return r.ok ? r : undefined;
  });
  log(`GET /api/health -> ${health.status} ${(await health.text()).slice(0, 80)}`);
  const index = await fetch(`${base}/`);
  const html = await index.text();
  if (!index.ok || !/<html/i.test(html) || !/id="root"/.test(html)) fail(`GET / did not serve the web app (status ${index.status})`);
  log('GET / -> the web app index');
}

function stopTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
}

async function smokeServer(resources: string, node: string): Promise<void> {
  const serverJs = join(resources, 'server', 'main.js');
  if (!existsSync(serverJs)) fail(`${serverJs} is missing`);
  // better-sqlite3 must load under THIS node, from the bundle's own node_modules.
  const req = createRequire(serverJs);
  const probe = spawn(node, ['-e', `const D=require(${JSON.stringify(req.resolve('better-sqlite3'))});const d=new D(':memory:');console.log(d.prepare('select sqlite_version() v').get().v)`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let out = '';
  probe.stdout.on('data', (b) => (out += String(b)));
  const code = await new Promise<number | null>((r) => probe.on('exit', r));
  if (code !== 0 || !out.trim()) fail(`better-sqlite3 does not load with ${node} (exit ${code})`);
  log(`better-sqlite3 loads (SQLite ${out.trim()})`);

  const sb = sandbox();
  const port = await freePort();
  const child = spawn(node, [serverJs], {
    cwd: sb.dir,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...sb.env,
      OFFICE_SERVER__HOST: '127.0.0.1',
      OFFICE_SERVER__PORT: String(port),
      OFFICE_SERVER__WEB_DIR: join(resources, 'web'),
      OFFICE_SERVER__ALLOWED_HOSTS: JSON.stringify(['localhost', '127.0.0.1']),
      OFFICE_STORAGE__DB_PATH: join(sb.dir, 'data', 'office.db'),
      OFFICE_PATHS__CLAUDE_DIR: join(sb.dir, 'claude'),
      OFFICE_PATHS__AGENTS_DIR: join(sb.dir, 'claude', 'agents'),
      OFFICE_PATHS__PROJECTS_DIR: join(sb.dir, 'claude', 'projects'),
    },
  });
  try {
    const exited = new Promise<never>((_, rej) => child.once('exit', (c) => rej(new Error(`the server exited early (code ${c})`))));
    await Promise.race([checkHttp(`http://127.0.0.1:${port}`), exited]);
  } finally {
    stopTree(child);
    await sleep(500);
    rmSync(sb.dir, { recursive: true, force: true });
  }
  log('server smoke OK');
}

async function smokeRpc(resources: string, node: string): Promise<void> {
  const supervisorJs = join(resources, 'supervisor', 'supervisor.js');
  if (!existsSync(supervisorJs)) fail(`${supervisorJs} is missing`);
  const sb = sandbox();
  const port = await freePort();
  const child = spawn(node, [supervisorJs], { cwd: sb.dir, stdio: ['pipe', 'pipe', 'inherit'], env: { ...sb.env, TAGCONN_BUNDLE_DIR: resources }, windowsHide: true });
  const pending = new Map<number, (m: { ok: boolean; result?: unknown; error?: { message: string } }) => void>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const m = JSON.parse(line) as { id?: number };
    if (m.id !== undefined) pending.get(m.id)?.(m as never);
  });
  const exited = new Promise<number | null>((r) => child.once('exit', r));
  let seq = 0;
  const call = async <T>(method: string, params: object = {}): Promise<T> => {
    const id = ++seq;
    const reply = new Promise<{ ok: boolean; result?: unknown; error?: { message: string } }>((r) => pending.set(id, r));
    child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
    const m = await Promise.race([reply, sleep(90_000).then(() => fail(`${method}: no response`))]);
    if (!m.ok) fail(`${method} failed: ${m.error?.message}`);
    return m.result as T;
  };
  let serverPid: number | undefined;
  try {
    const info = await call<{ appVersion: string; nodeVersion: string; platform: string }>('app.info');
    log(`app.info: app ${info.appVersion}, node ${info.nodeVersion}, ${info.platform}`);
    await call('config.set', { serverPort: port });
    const started = await call<{ state: string; pid?: number }>('service.start', { id: 'server' });
    serverPid = started.pid;
    log(`service.start server -> ${started.state} (pid ${serverPid})`);
    await checkHttp(`http://127.0.0.1:${port}`);
    const stopped = await call<{ state: string }>('service.stop', { id: 'server' });
    log(`service.stop server -> ${stopped.state}`);
    if (stopped.state !== 'stopped') fail(`the server is "${stopped.state}" after service.stop`);
    if (serverPid !== undefined) await waitFor('the server process to exit', async () => (alive(serverPid!) ? undefined : true), 15_000);
    child.stdin!.end();
    const code = await Promise.race([exited, sleep(30_000).then(() => fail('the supervisor did not exit after stdin closed'))]);
    if (code !== 0) fail(`the supervisor exited with code ${code}`);
    if (child.pid !== undefined && alive(child.pid)) fail('the supervisor is still running');
    log('no leftover processes');
  } finally {
    if (child.exitCode === null) stopTree(child);
    if (serverPid !== undefined && alive(serverPid)) process.kill(serverPid);
    await sleep(500);
    rmSync(sb.dir, { recursive: true, force: true });
  }
  log('rpc smoke OK');
}

function arg(argv: string[], name: string): string {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v ? resolve(v) : fail(`--${name} <path> is required`);
}

async function main(argv: string[]): Promise<void> {
  const mode = argv[0];
  const resources = arg(argv, 'resources');
  const node = arg(argv, 'node');
  if (!existsSync(node)) fail(`node not found at ${node}`);
  if (mode === 'server') await smokeServer(resources, node);
  else if (mode === 'rpc') await smokeRpc(resources, node);
  else fail('usage: smoke-desktop.ts <server|rpc> --resources DIR --node NODE');
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(`smoke-desktop failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
