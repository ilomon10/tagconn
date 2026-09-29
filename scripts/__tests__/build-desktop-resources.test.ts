import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyPlan, DEPLOYS, NODE_VERSION, nodeDistFor, parseArgs, parseShasums, supportedTriples } from '../build-desktop-resources.ts';

describe('nodeDistFor', () => {
  it('maps the Windows x64 triple to the zip and node.exe', () => {
    expect(nodeDistFor('x86_64-pc-windows-msvc', '24.21.0')).toEqual({
      triple: 'x86_64-pc-windows-msvc',
      slug: 'win-x64',
      archive: 'node-v24.21.0-win-x64.zip',
      ext: 'zip',
      binInArchive: 'node-v24.21.0-win-x64/node.exe',
      sidecar: 'node-x86_64-pc-windows-msvc.exe',
      prebuild: 'win32-x64.node',
    });
  });

  it('maps the Linux triples to tar.xz and bin/node', () => {
    const x64 = nodeDistFor('x86_64-unknown-linux-gnu');
    expect(x64.archive).toBe(`node-v${NODE_VERSION}-linux-x64.tar.xz`);
    expect(x64.binInArchive).toBe(`node-v${NODE_VERSION}-linux-x64/bin/node`);
    expect(x64.sidecar).toBe('node-x86_64-unknown-linux-gnu');
    expect(x64.prebuild).toBe('linux-x64.node');
    const arm = nodeDistFor('aarch64-unknown-linux-gnu');
    expect(arm.archive).toContain('linux-arm64');
    expect(arm.prebuild).toBe('linux-arm64.node');
  });

  it('rejects unsupported triples with the list of supported ones', () => {
    expect(() => nodeDistFor('x86_64-apple-darwin')).toThrow(/unsupported target.*x86_64-unknown-linux-gnu/);
    expect(() => nodeDistFor('__proto__')).toThrow(/unsupported target/);
    expect(supportedTriples()).toContain('x86_64-pc-windows-msvc');
  });
});

describe('parseShasums', () => {
  const a = 'a'.repeat(64);
  const b = 'B'.repeat(64);
  it('reads "<sha256>  <file>" lines, lowercases digests and ignores junk', () => {
    const map = parseShasums(`${a}  node-v24.21.0-linux-x64.tar.xz\r\n\nnot a checksum line\n${b} *node-v24.21.0-win-x64.zip\n`);
    expect(map.get('node-v24.21.0-linux-x64.tar.xz')).toBe(a);
    expect(map.get('node-v24.21.0-win-x64.zip')).toBe('b'.repeat(64));
    expect(map.size).toBe(2);
  });
  it('returns an empty map for an HTML error page', () => {
    expect(parseShasums('<html>404</html>').size).toBe(0);
  });
});

describe('copyPlan', () => {
  const plan = copyPlan('/repo');
  const to = plan.map((s) => s.to);
  it('lays out what apps/supervisor/src/paths.ts resolveBundle expects', () => {
    expect(to).toEqual(
      expect.arrayContaining([
        join('supervisor', 'supervisor.js'),
        join('server', 'main.js'),
        join('runner', 'main.js'),
        'web',
        join('hook', 'office-hook.mjs'),
        join('agent-templates', 'roles'),
        join('agent-templates', 'skills'),
        join('agent-templates', 'attribution'),
        'docker-compose.yml',
      ]),
    );
  });
  it('reads from the built workspace dirs', () => {
    expect(plan.find((s) => s.to === 'web')?.from).toBe(join('/repo', 'apps', 'web', 'dist'));
    expect(plan.find((s) => s.to === 'docker-compose.yml')?.from).toBe(join('/repo', 'apps', 'supervisor', 'compose', 'docker-compose.yml'));
  });
  it('deploys production node_modules for the server and the runner', () => {
    expect(DEPLOYS.map((d) => d.to)).toEqual(['server', 'runner']);
  });
});

describe('parseArgs', () => {
  it('requires a valid --target', () => {
    expect(() => parseArgs([])).toThrow(/--target/);
    expect(() => parseArgs(['--target', 'riscv64'])).toThrow(/unsupported/);
    expect(() => parseArgs(['--target'])).toThrow(/needs a value/);
  });
  it('rejects unknown flags and a bad node version', () => {
    expect(() => parseArgs(['--target', 'x86_64-unknown-linux-gnu', '--bogus'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--target', 'x86_64-unknown-linux-gnu', '--node-version', 'latest'])).toThrow(/X\.Y\.Z/);
  });
  it('resolves the cache from the flag, then the env, and defaults the outputs into src-tauri', () => {
    const t = 'x86_64-pc-windows-msvc';
    expect(parseArgs(['--target', t, '--cache-dir', '/c1'], { TAGCONN_DESKTOP_CACHE: '/c2' }).cacheDir).toBe('/c1');
    expect(parseArgs(['--target', t], { TAGCONN_DESKTOP_CACHE: '/c2' }).cacheDir).toBe('/c2');
    const a = parseArgs(['--target', t, '--skip-node']);
    expect(a.skipNode).toBe(true);
    expect(a.out).toMatch(/src-tauri[\\/]resources$/);
    expect(a.binariesDir).toMatch(/src-tauri[\\/]binaries$/);
    expect(a.nodeVersion).toBe(NODE_VERSION);
  });
});
