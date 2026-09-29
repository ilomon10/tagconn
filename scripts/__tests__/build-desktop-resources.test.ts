import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectDeployedPackages,
  copyPlan,
  DEPLOYS,
  lockfileViolations,
  NODE_VERSION,
  nodeDistFor,
  parseArgs,
  parseLockfilePackages,
  parseShasums,
  pinnedSha256,
  PINNED_NODE_SHA256,
  supportedTriples,
  verifyDeploy,
} from '../build-desktop-resources.ts';

describe('nodeDistFor', () => {
  it('maps the Windows x64 triple to the zip and node.exe', () => {
    expect(nodeDistFor('x86_64-pc-windows-msvc', '24.21.0')).toEqual({
      triple: 'x86_64-pc-windows-msvc',
      slug: 'win-x64',
      archive: 'node-v24.21.0-win-x64.zip',
      ext: 'zip',
      binInArchive: 'node-v24.21.0-win-x64/node.exe',
      sidecar: 'tagconn-node-x86_64-pc-windows-msvc.exe',
      prebuild: 'win32-x64.node',
    });
  });

  it('maps the Linux triples to tar.xz and bin/node', () => {
    const x64 = nodeDistFor('x86_64-unknown-linux-gnu');
    expect(x64.archive).toBe(`node-v${NODE_VERSION}-linux-x64.tar.xz`);
    expect(x64.binInArchive).toBe(`node-v${NODE_VERSION}-linux-x64/bin/node`);
    expect(x64.sidecar).toBe('tagconn-node-x86_64-unknown-linux-gnu');
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

describe('pinnedSha256', () => {
  it('has a 64-hex pin for the archive of every supported triple at the default version', () => {
    for (const triple of supportedTriples()) {
      expect(pinnedSha256(NODE_VERSION, nodeDistFor(triple).archive)).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(PINNED_NODE_SHA256[NODE_VERSION] ?? {})).toHaveLength(supportedTriples().length);
  });
  it('returns undefined for an unpinned version, archive or prototype key', () => {
    expect(pinnedSha256('24.0.0', 'node-v24.0.0-linux-x64.tar.xz')).toBeUndefined();
    expect(pinnedSha256(NODE_VERSION, 'node-v24.21.0-darwin-arm64.tar.gz')).toBeUndefined();
    expect(pinnedSha256('__proto__', 'x')).toBeUndefined();
    expect(pinnedSha256(NODE_VERSION, 'constructor')).toBeUndefined();
  });
});

const LOCK = `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      socket.io:
        specifier: ^4.8.0
        version: 4.8.3

packages:

  '@fastify/cors@11.0.1':
    resolution: {integrity: sha512-x}

  socket.io@4.8.3:
    resolution: {integrity: sha512-y}
    engines: {node: '>=10.2.0'}

  "quoted@1.0.0":
    resolution: {integrity: sha512-z}

snapshots:

  socket.io@4.8.3:
    dependencies:
      other: 1.0.0

  notinpackages@1.0.0: {}
`;

describe('parseLockfilePackages', () => {
  it('reads only the keys of the packages: section', () => {
    expect([...parseLockfilePackages(LOCK)].sort()).toEqual(['@fastify/cors@11.0.1', 'quoted@1.0.0', 'socket.io@4.8.3']);
  });
  it('is empty without a packages: section', () => {
    expect(parseLockfilePackages('lockfileVersion: 9\n').size).toBe(0);
  });
});

describe('lockfileViolations', () => {
  const lock = parseLockfilePackages(LOCK);
  it('flags a version that differs from the lockfile and an unknown package', () => {
    const bad = lockfileViolations(
      [
        { name: 'socket.io', version: '4.8.4', dir: '/nm/socket.io' },
        { name: '@fastify/cors', version: '11.0.1', dir: '/nm/@fastify/cors' },
        { name: 'evil', version: '1.0.0', dir: '/nm/evil' },
      ],
      lock,
    );
    expect(bad).toEqual(['socket.io@4.8.4 (/nm/socket.io)', 'evil@1.0.0 (/nm/evil)']);
  });
  it('skips the ignored workspace packages', () => {
    expect(lockfileViolations([{ name: '@tagconn/shared', version: '0.3.0', dir: '/x' }], lock, new Set(['@tagconn/shared']))).toEqual([]);
  });
});

describe('collectDeployedPackages / verifyDeploy', () => {
  const pkg = (dir: string, name: string, version: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
  };
  it('finds hoisted, scoped, nested and .pnpm virtual-store packages and checks them', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagconn-deploy-'));
    try {
      const nm = join(root, 'node_modules');
      pkg(join(nm, 'socket.io'), 'socket.io', '4.8.3');
      pkg(join(nm, '@fastify', 'cors'), '@fastify/cors', '11.0.1');
      pkg(join(nm, 'socket.io', 'node_modules', 'quoted'), 'quoted', '1.0.0');
      pkg(join(nm, '.pnpm', 'quoted@1.0.0', 'node_modules', 'quoted'), 'quoted', '1.0.0');
      mkdirSync(join(nm, '.bin'), { recursive: true });
      symlinkSync(join(nm, '.pnpm', 'quoted@1.0.0', 'node_modules', 'quoted'), join(nm, 'quoted'), 'dir');
      const found = collectDeployedPackages(nm).map((p) => `${p.name}@${p.version}`);
      expect(found.filter((f) => f === 'quoted@1.0.0')).toHaveLength(2); // nested copy + the store copy (symlink deduped)
      expect(found).toEqual(expect.arrayContaining(['socket.io@4.8.3', '@fastify/cors@11.0.1']));
      const lock = join(root, 'pnpm-lock.yaml');
      writeFileSync(lock, LOCK);
      expect(verifyDeploy(nm, lock)).toBe(found.length);
      pkg(join(nm, 'socket.io'), 'socket.io', '4.8.4');
      expect(() => verifyDeploy(nm, lock)).toThrow(/socket\.io@4\.8\.4/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('fails on an empty node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'tagconn-deploy-'));
    try {
      writeFileSync(join(root, 'l.yaml'), LOCK);
      expect(() => verifyDeploy(join(root, 'node_modules'), join(root, 'l.yaml'))).toThrow(/no packages found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
