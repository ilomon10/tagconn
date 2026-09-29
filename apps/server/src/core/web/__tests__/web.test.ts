import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSET_CACHE_CONTROL, INDEX_CACHE_CONTROL, SECURITY_HEADERS } from '@tagconn/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp, makeTempDir } from '../../../../test/helpers.js';

let webDir: string;
beforeAll(() => {
  webDir = makeTempDir('tagconn-web-');
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>tagconn</title>');
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(webDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});
const build = async (settings = { server: { webDir } }) => (app = await buildTestApp({ settings }));
const expectSecurityHeaders = (headers: Record<string, unknown>) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(headers[name.toLowerCase()], name).toBe(value);
};

describe('web plugin', () => {
  it('is inert without server.webDir', async () => {
    app = await buildTestApp();
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/health' })).headers['content-security-policy']).toBeUndefined();
  });

  it('serves index.html at / with no-store and the security headers', async () => {
    const res = await (await build()).inject({ url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>tagconn</title>');
    expect(res.headers['cache-control']).toBe(INDEX_CACHE_CONTROL);
    expectSecurityHeaders(res.headers);
  });

  it('serves /assets/* immutable with the security headers', async () => {
    const res = await (await build()).inject({ url: '/assets/app-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(ASSET_CACHE_CONTROL);
    expectSecurityHeaders(res.headers);
  });

  it('serves other files without the immutable cache header', async () => {
    const res = await (await build()).inject({ url: '/favicon.svg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).not.toBe(ASSET_CACHE_CONTROL);
    expectSecurityHeaders(res.headers);
  });

  it('SPA fallback: a deep link returns index.html (no-store), HEAD too', async () => {
    await build();
    const res = await app!.inject({ url: '/quests/abc?x=1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<title>tagconn</title>');
    expect(res.headers['cache-control']).toBe(INDEX_CACHE_CONTROL);
    expectSecurityHeaders(res.headers);
    expect((await app!.inject({ method: 'HEAD', url: '/quests/abc' })).statusCode).toBe(200);
  });

  it('a missing /assets file is a 404, not index.html', async () => {
    const res = await (await build()).inject({ url: '/assets/missing.js' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).not.toBe(ASSET_CACHE_CONTROL);
  });

  it('non-GET unknown paths and unknown /api paths stay JSON 404s without the web headers', async () => {
    await build();
    const post = await app!.inject({ method: 'POST', url: '/nope', payload: {} });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toEqual({ error: 'Not Found', statusCode: 404 });
    const api = await app!.inject({ url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toMatch(/application\/json/);
    expect(api.json()).toEqual({ error: 'Not Found', statusCode: 404 });
    expect(api.headers['content-security-policy']).toBeUndefined();
    const health = await app!.inject({ url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.headers['content-security-policy']).toBeUndefined();
  });

  it.each(['/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc/passwd', '/%2e%2e%5c%2e%2e%5cetc%5cpasswd', '/assets/../../etc/passwd', '/a%00b', '/%zz'])(
    'refuses traversal %s',
    async (url) => {
      const res = await (await build()).inject({ url });
      // Either refused (4xx), or the router already collapsed `..` to an in-root path, which is just the SPA index.
      expect(res.statusCode).toBeLessThan(500);
      expect(res.body).not.toMatch(/root:/);
      if (res.statusCode === 200) expect(res.body).toBe('<!doctype html><title>tagconn</title>');
    },
  );

  it('enforces the Host allowlist on web routes (DNS rebinding)', async () => {
    await build();
    for (const url of ['/', '/assets/app-abc123.js', '/some/deep/link']) {
      const res = await app!.inject({ url, headers: { host: 'evil.example.com' } });
      expect(res.statusCode, url).toBe(403);
      expect(res.body).not.toContain('<title>');
    }
  });

  it('refuses symlinks that leave the web dir but serves ones inside it', async () => {
    const dir = makeTempDir('tagconn-web-link-');
    const outside = makeTempDir('tagconn-web-outside-');
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>tagconn</title>');
    writeFileSync(join(dir, 'real.txt'), 'inside');
    writeFileSync(join(outside, 'secret.txt'), 'SECRET');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'leak.txt'));
    symlinkSync(outside, join(dir, 'leakdir'));
    symlinkSync(join(dir, 'real.txt'), join(dir, 'ok.txt'));
    await build({ server: { webDir: dir } });
    for (const url of ['/leak.txt', '/leakdir/secret.txt']) {
      const res = await app!.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('SECRET');
    }
    expect((await app!.inject({ url: '/ok.txt' })).body).toBe('inside');
  });

  it('N13: refuses a directory request whose index.html is a symlink leaving the web dir', async () => {
    const dir = makeTempDir('tagconn-web-idx-');
    const outside = makeTempDir('tagconn-web-idx-out-');
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>tagconn</title>');
    writeFileSync(join(outside, 'index.html'), 'SECRET-INDEX');
    mkdirSync(join(dir, 'sub'));
    symlinkSync(join(outside, 'index.html'), join(dir, 'sub', 'index.html'));
    symlinkSync(outside, join(dir, 'linked'));
    await build({ server: { webDir: dir } });
    for (const url of ['/sub/', '/sub', '/linked/', '/linked']) {
      const res = await app!.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body).not.toContain('SECRET-INDEX');
    }
    expect((await app!.inject({ url: '/' })).body).toContain('<title>tagconn</title>');
  });

  it('N13: does not serve when the root index.html itself is a symlink leaving the web dir', async () => {
    const dir = makeTempDir('tagconn-web-rootidx-');
    const outside = makeTempDir('tagconn-web-rootidx-out-');
    writeFileSync(join(outside, 'index.html'), 'SECRET-INDEX');
    symlinkSync(join(outside, 'index.html'), join(dir, 'index.html'));
    const res = await (await build({ server: { webDir: dir } })).inject({ url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('SECRET-INDEX');
  });

  it('does not serve when webDir has no index.html', async () => {
    const res = await (await build({ server: { webDir: makeTempDir('tagconn-empty-') } })).inject({ url: '/' });
    expect(res.statusCode).toBe(404);
  });
});
