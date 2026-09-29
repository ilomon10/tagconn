import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSET_CACHE_CONTROL, DEV_CONTENT_SECURITY_POLICY, INDEX_CACHE_CONTROL, SECURITY_HEADERS } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';

const nginx = readFileSync(join(import.meta.dirname, '../../../../../../docker/nginx.conf'), 'utf8').replace(/^\s*#.*$/gm, '');

/** `map $host $<name> { default "<value>"; }` */
const mapDefault = (name: string): string => {
  const m = new RegExp(`map \\$host \\$${name} \\{\\s*default "([^"]*)";`).exec(nginx);
  if (!m?.[1]) throw new Error(`nginx.conf has no map for $${name}`);
  return m[1];
};

/** `location <spec> { ... }` bodies (no nested braces in this file). */
const locations = [...nginx.matchAll(/location\s+([^{]+?)\s*\{([^}]*)\}/g)].map((m) => ({ spec: m[1] as string, body: m[2] as string }));

const headersOf = (body: string): Record<string, string> => {
  const vars: Record<string, string> = { $csp: mapDefault('csp'), $permissions_policy: mapDefault('permissions_policy') };
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/add_header\s+(\S+)\s+(?:"([^"]*)"|(\$\w+))\s+always;/g)) out[m[1] as string] = m[2] ?? vars[m[3] as string] ?? '';
  return out;
};

describe('docker/nginx.conf vs @tagconn/shared securityHeaders (drift guard)', () => {
  it('found the locations', () => {
    expect(locations.map((l) => l.spec)).toEqual(['/api/', '/api/auth/', '/socket.io/', '/assets/', '= /index.html', '/']);
  });

  it.each(locations.map((l) => [l.spec, l.body] as const))('location %s sends exactly the shared headers', (_spec, body) => {
    const sent = headersOf(body);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(sent[name], name).toBe(value);
  });

  it('cache headers match: /assets/ immutable, index.html and /api/auth/ no-store', () => {
    const by = (spec: string) => headersOf(locations.find((l) => l.spec === spec)?.body ?? '');
    expect(by('/assets/')['Cache-Control']).toBe(ASSET_CACHE_CONTROL);
    expect(by('= /index.html')['Cache-Control']).toBe(INDEX_CACHE_CONTROL);
    expect(by('/api/auth/')['Cache-Control']).toBe('no-store');
  });

  it('the dev CSP only relaxes script-src and style-src', () => {
    expect(DEV_CONTENT_SECURITY_POLICY).toContain("script-src 'self' 'unsafe-inline';");
    expect(DEV_CONTENT_SECURITY_POLICY).toContain("style-src 'self' 'unsafe-inline';");
    expect(DEV_CONTENT_SECURITY_POLICY.replace(" 'unsafe-inline'", '').replace(" 'unsafe-inline'", '')).toBe(SECURITY_HEADERS['Content-Security-Policy']);
  });
});
