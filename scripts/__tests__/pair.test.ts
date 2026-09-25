// Tests for scripts/pair.ts's HMAC pairing handshake (docs/design/runner-and-helpdesk.md
// §5.2), against a fake HTTP server that plays the role of the tagconn server (and,
// separately, the web origin used for the :4318 squatter check). The raw runner
// token must never appear in any request body/query - only HMAC proofs do.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mintPairingCode, parseArgs, readRunnerToken } from '../pair.ts';

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

/** A minimal fake server implementing the two pairing endpoints + /api/health, keyed with REAL_TOKEN. */
function startFakeServer(instanceId = INSTANCE_ID, version = VERSION): Promise<{ server: Server; url: string }> {
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
        send(200, { code: 'ABCD-EFGH-JKMN', url: 'http://localhost:4318/#pair=ABCD-EFGH-JKMN', expiresAt: Date.now() + 600_000 });
        return;
      }
      send(404, { error: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe('mintPairingCode', () => {
  let server: Server;
  let url: string;

  beforeEach(async () => {
    ({ server, url } = await startFakeServer());
  });

  afterEach(() => {
    server.close();
  });

  it('completes the two-step HMAC handshake and returns the pairing code + URL', async () => {
    const result = await mintPairingCode(url, url, REAL_TOKEN, 'test session', false);
    expect(result.code).toBe('ABCD-EFGH-JKMN');
    expect(result.url).toBe('http://localhost:4318/#pair=ABCD-EFGH-JKMN');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    // Same instanceId on both "url" and "webUrl" here, so the squatter check passes.
    expect(result.squatterCheckPassed).toBe(true);
  });

  it('refuses (throws) when the runner token is wrong: the server proof cannot be verified', async () => {
    await expect(mintPairingCode(url, url, WRONG_TOKEN, undefined, true)).rejects.toThrow(/server proof invalid/);
  });

  it('flags a mismatched instanceId on the web origin as a possible squatter, but still returns the code', async () => {
    const web = await startFakeServer('a-different-instance', VERSION);
    try {
      const result = await mintPairingCode(url, web.url, REAL_TOKEN, undefined, false);
      expect(result.squatterCheckPassed).toBe(false);
      expect(result.code).toBe('ABCD-EFGH-JKMN');
    } finally {
      web.server.close();
    }
  });

  it('skips the squatter check when asked, leaving it undefined', async () => {
    const result = await mintPairingCode(url, 'http://127.0.0.1:1', REAL_TOKEN, undefined, true);
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
      await mintPairingCode(url, url, REAL_TOKEN, undefined, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    for (const body of seenBodies) {
      expect(body).not.toContain(REAL_TOKEN);
    }
    expect(seenBodies.length).toBeGreaterThan(0);
  });
});

describe('readRunnerToken', () => {
  it('reads the token out of <configDir>/runner.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagconn-pair-test-'));
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ token: REAL_TOKEN, allowedProjectDirs: [] }), { mode: 0o600 });
    expect(readRunnerToken(dir)).toBe(REAL_TOKEN);
  });

  it('throws a clear error when runner.json is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagconn-pair-test-'));
    expect(() => readRunnerToken(dir)).toThrow(/runner\.json/);
  });

  it('throws when runner.json has no token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagconn-pair-test-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'runner.json'), JSON.stringify({ allowedProjectDirs: [] }));
    expect(() => readRunnerToken(dir)).toThrow(/no runner token/);
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
    const args = parseArgs(['--config-dir', '/tmp/x', '--url', 'http://h:1', '--web-url', 'http://h:2', '--label', 'L', '--no-squatter-check']);
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
});
