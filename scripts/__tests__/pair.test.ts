// Tests for scripts/pair.ts's HMAC pairing handshake (docs/design/runner-and-helpdesk.md
// §5.2), against fake HTTP servers that play the role of the tagconn server (:4317-ish)
// and, separately, the browser-facing web origin (:4318-ish) used for the squatter check.
// The raw runner token must never appear in any request body/query - only HMAC proofs do.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintPairingCode, pairFailureHint, parseArgs, readRunnerToken } from '../pair.ts';

const REAL_TOKEN = 'a'.repeat(64);
const WRONG_TOKEN = 'b'.repeat(64);
const INSTANCE_ID = 'instance-real-1';
const VERSION = '0.9.9';

function hmac(token: string, message: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8')).update(message).digest('base64url');
}

function proofsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** A minimal health-only server: what the browser-facing web origin (nginx/:4318) looks like. */
function startFakeHealthServer(instanceId: string, version: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ instanceId, version }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * A fake main server implementing the two pairing endpoints + /api/health, keyed with REAL_TOKEN.
 * `codeUrl` is what a real server would build from `server.corsOrigins[0]` (the WEB origin, e.g.
 * :4318) - callers pass the fake web server's own url to simulate a correctly configured server,
 * or something else entirely to simulate a server pointing pairing links at the wrong place.
 */
function startFakeServer(opts: { instanceId?: string; version?: string; codeUrl: string }): Promise<{ server: Server; url: string }> {
  const instanceId = opts.instanceId ?? INSTANCE_ID;
  const version = opts.version ?? VERSION;
  let lastChallenge: { challengeId: string; nc: string; ns: string } | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      const body = bodyText ? JSON.parse(bodyText) : {};
      const send = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.url === '/api/health') {
        send(200, { instanceId, version });
        return;
      }
      if (req.url === '/api/auth/pairing-challenge' && req.method === 'POST') {
        const nc = body.nonce as string;
        const ns = 'S'.repeat(43);
        const challengeId = 'challenge-1';
        lastChallenge = { challengeId, nc, ns };
        const proof = hmac(REAL_TOKEN, ['tagconn-pair-v1', 'server', nc, ns, instanceId].join('|'));
        send(200, { challengeId, nonce: ns, instanceId, proof });
        return;
      }
      if (req.url === '/api/auth/pairing-codes' && req.method === 'POST') {
        if (!lastChallenge || body.challengeId !== lastChallenge.challengeId) {
          send(400, { error: 'unknown challenge' });
          return;
        }
        const expected = hmac(REAL_TOKEN, ['tagconn-pair-v1', 'client', lastChallenge.ns, lastChallenge.nc].join('|'));
        if (!proofsEqual(expected, body.proof)) {
          send(401, { error: 'bad proof' });
          return;
        }
        send(200, { code: 'ABCD-EFGH-JKMN', url: `${opts.codeUrl}#pair=ABCD-EFGH-JKMN`, expiresAt: Date.now() + 600_000 });
        return;
      }
      send(404, { error: 'not found' });
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('mintPairingCode', () => {
  let webServer: Server;
  let webUrl: string;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    // A correctly configured setup: the main server's pairing-code URL points at the (separate)
    // web server's real origin, and both report the same instanceId/version.
    ({ server: webServer, url: webUrl } = await startFakeHealthServer(INSTANCE_ID, VERSION));
    ({ server, url } = await startFakeServer({ codeUrl: webUrl }));
  });

  afterEach(() => {
    server.close();
    webServer.close();
  });

  it('completes the two-step HMAC handshake, returns the pairing code + URL, and passes the squatter check', async () => {
    const result = await mintPairingCode(url, webUrl, REAL_TOKEN, false);
    expect(result.code).toBe('ABCD-EFGH-JKMN');
    expect(result.url).toBe(`${webUrl}#pair=ABCD-EFGH-JKMN`);
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.squatterCheckPassed).toBe(true);
  });

  it('refuses (throws) when the runner token is wrong: the server proof cannot be verified', async () => {
    await expect(mintPairingCode(url, webUrl, WRONG_TOKEN, true)).rejects.toThrow(/server proof invalid/);
  });

  it('fails the squatter check on a mismatched instanceId, but still returns the code', async () => {
    const squatter = await startFakeHealthServer('a-different-instance', VERSION);
    try {
      const result = await mintPairingCode(url, squatter.url, REAL_TOKEN, false);
      expect(result.squatterCheckPassed).toBe(false);
      expect(result.code).toBe('ABCD-EFGH-JKMN');
    } finally {
      squatter.server.close();
    }
  });

  it('fails the squatter check on a mismatched version, even with a matching instanceId (SC4 M3)', async () => {
    // Same-origin trick: point the pairing code's declared web origin at THIS mismatched-version
    // server too, so the origin check passes and only the version differs.
    const mismatchedVersion = await startFakeHealthServer(INSTANCE_ID, '0.0.1-different');
    const serverB = await startFakeServer({ codeUrl: mismatchedVersion.url });
    try {
      const result = await mintPairingCode(serverB.url, mismatchedVersion.url, REAL_TOKEN, false);
      expect(result.squatterCheckPassed).toBe(false);
    } finally {
      serverB.server.close();
      mismatchedVersion.server.close();
    }
  });

  it('fails the squatter check when the pairing URL points at a different origin than --web-url (SC4 M3)', async () => {
    // codeUrl deliberately does NOT match webUrl's real origin, even though health matches.
    const serverB = await startFakeServer({ codeUrl: 'http://evil.example:9999' });
    try {
      const result = await mintPairingCode(serverB.url, webUrl, REAL_TOKEN, false);
      expect(result.squatterCheckPassed).toBe(false);
    } finally {
      serverB.server.close();
    }
  });

  it('skips the squatter check when asked, leaving it undefined', async () => {
    const result = await mintPairingCode(url, 'http://127.0.0.1:1', REAL_TOKEN, true);
    expect(result.squatterCheckPassed).toBeUndefined();
  });

  it('never sends the raw token: only HMAC proofs appear in outgoing requests', async () => {
    const seenBodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) seenBodies.push(String(init.body));
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await mintPairingCode(url, webUrl, REAL_TOKEN, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    for (const body of seenBodies) {
      expect(body).not.toContain(REAL_TOKEN);
    }
    expect(seenBodies.length).toBeGreaterThan(0);
  });

  it('never sends a "label" key to /api/auth/pairing-codes (QA regression: the endpoint is a strictObject of {challengeId, proof} and rejects unknown keys)', async () => {
    const seenBodies: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === 'string' && input.includes('/api/auth/pairing-codes') && init?.body) {
        seenBodies.push(String(init.body));
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      await mintPairingCode(url, webUrl, REAL_TOKEN, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seenBodies.length).toBeGreaterThan(0);
    for (const body of seenBodies) {
      expect(JSON.parse(body)).not.toHaveProperty('label');
    }
  });
});

describe('main(): fail-closed on a squatter mismatch (SC4 M3)', () => {
  // main() itself is exercised via the CLI in this repo's manual/QA pass; here we assert the
  // building block it relies on (mintPairingCode's squatterCheckPassed) is correctly false so a
  // caller that checks it (as main() does) will refuse to print the code. See scripts/pair.ts's
  // main(): `if (result.squatterCheckPassed === false) { ...; process.exitCode = 1; return; }`.
  it('a false squatterCheckPassed is exactly the signal main() uses to withhold the code', async () => {
    const webA = await startFakeHealthServer(INSTANCE_ID, VERSION);
    const webB = await startFakeHealthServer('someone-elses-instance', VERSION);
    const server = await startFakeServer({ codeUrl: webA.url });
    try {
      const result = await mintPairingCode(server.url, webB.url, REAL_TOKEN, false);
      expect(result.squatterCheckPassed).toBe(false);
    } finally {
      server.server.close();
      webA.server.close();
      webB.server.close();
    }
  });
});

describe('readRunnerToken', () => {
  it('reads the token out of <configDir>/runner.json (mode 600)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagconn-pair-test-'));
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ token: REAL_TOKEN, allowedProjectDirs: [] }), { mode: 0o600 });
    expect(readRunnerToken(dir)).toBe(REAL_TOKEN);
  });

  it('throws a clear error when runner.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagconn-pair-test-'));
    expect(() => readRunnerToken(dir)).toThrow(/runner\.json/);
  });

  it('throws when runner.json is not mode 600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagconn-pair-test-'));
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ token: REAL_TOKEN, allowedProjectDirs: [] }), { mode: 0o644 });
    expect(() => readRunnerToken(dir)).toThrow(/mode/);
  });

  it('throws when runner.json has no token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagconn-pair-test-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ allowedProjectDirs: [] }), { mode: 0o600 });
    expect(() => readRunnerToken(dir)).toThrow(/no runner token/);
  });

  it('throws when the token does not match the runner token shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagconn-pair-test-'));
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ token: 'not-hex', allowedProjectDirs: [] }), { mode: 0o600 });
    expect(() => readRunnerToken(dir)).toThrow(/not a valid runner token/);
  });
});

describe('parseArgs', () => {
  it('defaults url/webUrl and reports --help', () => {
    const args = parseArgs([]);
    expect(args.url).toBe('http://127.0.0.1:4317');
    expect(args.webUrl).toBe('http://localhost:4318');
    expect(args.help).toBe(false);
  });

  it('parses --config-dir, --url, --web-url, --label and --no-squatter-check', () => {
    const args = parseArgs([
      '--config-dir',
      '/tmp/x',
      '--url',
      'http://h:1',
      '--web-url',
      'http://h:2',
      '--label',
      'L',
      '--no-squatter-check',
    ]);
    expect(args.configDir).toBe('/tmp/x');
    expect(args.url).toBe('http://h:1');
    expect(args.webUrl).toBe('http://h:2');
    expect(args.label).toBe('L');
    expect(args.noSquatterCheck).toBe(true);
  });

  it('flags --help on an unknown argument', () => {
    const args = parseArgs(['--bogus']);
    expect(args.help).toBe(true);
  });

  it('rejects a non-http(s) --url (SC4 INFO: validate --url/--web-url)', () => {
    expect(() => parseArgs(['--url', 'ftp://evil.example'])).toThrow(/http or https/);
  });

  it('rejects a --web-url containing whitespace/quotes', () => {
    expect(() => parseArgs(['--web-url', 'http://evil.example/ "x'])).toThrow(/whitespace or quotes/);
  });
});

describe('pairFailureHint', () => {
  it('explains a server without a runner token (install, then office:up, or the log code)', () => {
    const hint = pairFailureHint('http://127.0.0.1:4317/api/auth/pairing-challenge failed: Pairing is disabled: settings.runner.token is not configured');
    expect(hint).toMatch(/office:install/);
    expect(hint).toMatch(/office:up/);
    expect(hint).toMatch(/logs server/);
  });

  it('adds nothing for other failures', () => {
    expect(pairFailureHint('server proof invalid')).toBeUndefined();
  });
});
