#!/usr/bin/env node
// A tiny stand-in for apps/supervisor with canned data, for exercising the Tauri shell and UI without
// the real services: TAGCONN_SUPERVISOR_CMD="node apps/desktop/dev/fake-sidecar.mjs".
// FAKE_CRASH_AFTER_MS=n exits after n ms (tests the relaunch-once and "service manager stopped" flow).
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const now = () => Date.now();
const services = { server: 'stopped', runner: 'stopped', docker: 'unavailable' };
const restarts = { server: 0, runner: 0, docker: 0 };
let config = { runMode: 'native', serverPort: 4317, allowedProjectDirs: [], attributionReadme: false, autoStartServices: false, openOfficeOnStart: false, dataDir: null };
let hooks = false;
const logs = [];
const status = (id) => ({ id, state: services[id], since: now(), restarts: restarts[id], ...(id === 'server' && services[id] === 'running' ? { url: `http://127.0.0.1:${config.serverPort}` } : {}) });
const log = (service, line) => {
  const l = { service, ts: now(), stream: 'stdout', line };
  logs.push(l);
  send({ method: 'log.line', params: l });
};
const paths = { config: '/tmp/fake/config', state: '/tmp/fake/state', data: '/tmp/fake/data', claudeDir: '/tmp/fake/.claude' };
const checks = () => [
  { id: 'claude_cli', title: 'Claude Code CLI', status: 'ok', detail: 'claude 2.1.283 found at /usr/bin/claude', required: true },
  { id: 'claude_login', title: 'Claude login', status: 'warn', detail: 'Not logged in. Run `claude` once and log in.', required: false, fix: { label: 'Re-check', action: 'recheck' } },
  { id: 'server_port', title: 'Server port', status: process.env.FAKE_PORT_BUSY ? 'fail' : 'ok', detail: process.env.FAKE_PORT_BUSY ? 'Port 4317 is in use' : 'Port 4317 is free', required: true, ...(process.env.FAKE_PORT_BUSY ? { fix: { label: 'Use next free port', action: 'use_next_free_port' } } : {}) },
  { id: 'claude_settings', title: 'Claude settings.json', status: 'ok', detail: paths.claudeDir + '/settings.json', required: true, fix: { label: 'Open file', action: 'open_file', target: paths.claudeDir + '/settings.json' } },
  { id: 'hooks', title: 'Hooks', status: hooks ? 'ok' : 'warn', detail: hooks ? 'Installed' : 'Not installed', required: false, fix: { label: 'Install hooks', action: 'install_hooks' } },
  { id: 'docker', title: 'Docker', status: 'skip', detail: 'Only needed in Docker mode', required: false },
];
const handlers = {
  'app.info': () => ({ rpcVersion: 1, appVersion: '0.4.1-fake', nodeVersion: process.version, platform: process.platform, arch: process.arch, paths }),
  'setup.check': checks,
  'setup.install': () => ((hooks = true), { changed: [paths.claudeDir + '/settings.json', paths.config + '/hook.json'], backup: paths.claudeDir + '/settings.json.tagconn-backup-fake' }),
  'setup.uninstall': () => ((hooks = false), { changed: [paths.claudeDir + '/settings.json'], backup: null }),
  'config.get': () => config,
  'config.set': (p) => (config = { ...config, ...p }),
  'service.status': () => Object.keys(services).map(status),
  'service.start': ({ id }) => ((services[id] = 'running'), log(id, `${id} started`), status(id)),
  'service.stop': ({ id }) => ((services[id] = 'stopped'), log(id, `${id} stopped`), status(id)),
  'service.restart': ({ id }) => ((services[id] = 'running'), restarts[id]++, status(id)),
  'logs.tail': ({ service, lines }) => logs.filter((l) => l.service === service).slice(-lines),
  'pair.mint': () => ({ code: 'FAKE-CODE', url: `http://127.0.0.1:${config.serverPort}/#pair=FAKE-CODE`, expiresAt: now() + 60_000 }),
  'diagnostics.collect': () => ({ text: 'fake diagnostics\n' + JSON.stringify(services) }),
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const h = handlers[req.method];
  if (!h) return send({ id: req.id, ok: false, error: { code: 'unknown_method', message: req.method } });
  setTimeout(() => {
    try {
      const result = h(req.params ?? {});
      send({ id: req.id, ok: true, result });
      if (req.method.startsWith('service.')) send({ method: 'service.changed', params: status(req.params.id) });
    } catch (e) {
      send({ id: req.id, ok: false, error: { code: 'internal', message: String(e) } });
    }
  }, 150);
});
process.stdin.on('end', () => process.exit(0));
if (process.env.FAKE_CRASH_AFTER_MS) setTimeout(() => process.exit(3), Number(process.env.FAKE_CRASH_AFTER_MS));
console.error('fake sidecar ready');
