import { HMAC_CONTEXTS, PAIRING_CODE_RE } from '@tagconn/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App } from '../../../app.js';
import { buildTestApp, mintAdminToken } from '../../../../test/helpers.js';
import { generateNonce, hmacProof } from '../auth.crypto.js';

describe('auth module (M8 8m)', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('GET /api/auth/status reports the mode/protect defaults and reflects a minted token', async () => {
    app = await buildTestApp();
    const before = (await app.inject({ url: '/api/auth/status' })).json();
    expect(before).toEqual({ mode: 'pairing', protect: 'all-writes', admin: false });

    const token = mintAdminToken(app);
    const after = (await app.inject({ url: '/api/auth/status', headers: { authorization: `Bearer ${token}` } })).json();
    expect(after).toMatchObject({ mode: 'pairing', protect: 'all-writes', admin: true });
    expect(after.sessionId).toBeTruthy();
    expect(after.expiresAt).toBeGreaterThan(Date.now());
  });

  it('/api/auth/* responses are never cached', async () => {
    app = await buildTestApp();
    const res = await app.inject({ url: '/api/auth/status' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rejects a missing, garbage, expired or revoked token on an admin route with 401 + WWW-Authenticate', async () => {
    app = await buildTestApp();
    const missing = await app.inject({ url: '/api/auth/sessions' });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('Bearer');

    const garbage = await app.inject({ url: '/api/auth/sessions', headers: { authorization: 'Bearer nope' } });
    expect(garbage.statusCode).toBe(401);

    const token = mintAdminToken(app);
    const ok = await app.inject({ url: '/api/auth/sessions', headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);

    // Expired: force the session's row into the past directly (no need to wait out sessionIdleHours).
    const { authRepository } = app.diContainer.cradle;
    const row = authRepository.listByLastUsedDesc()[0]!;
    authRepository.touch(row.id, Date.now() - 1_000, Date.now() - 1);
    const expired = await app.inject({ url: '/api/auth/sessions', headers: { authorization: `Bearer ${token}` } });
    expect(expired.statusCode).toBe(401);

    const token2 = mintAdminToken(app);
    const check = app.diContainer.cradle.authService.verify(token2);
    app.diContainer.cradle.authService.revoke(check.sessionId!);
    const revoked = await app.inject({ url: '/api/auth/sessions', headers: { authorization: `Bearer ${token2}` } });
    expect(revoked.statusCode).toBe(401);
  });

  it('admin-write routes are open under protect: execution, but admin routes stay gated (roles writes always gated)', async () => {
    app = await buildTestApp({ settings: { auth: { protect: 'execution' } } });
    const openWrite = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { office: { zoom: 2 } } });
    expect(openWrite.statusCode).toBe(200);

    const stillGated = await app.inject({ url: '/api/auth/sessions' });
    expect(stillGated.statusCode).toBe(401);
    const rolesWrite = await app.inject({ method: 'DELETE', url: '/api/roles/developer' });
    expect(rolesWrite.statusCode).toBe(401);
  });

  it('logs a pairing code (in pairing mode, no admin sessions yet) and stops once one exists', async () => {
    app = await buildTestApp();
    const spy = vi.spyOn(app.log, 'info');
    app.diContainer.cradle.authService.logBootPairingCodeIfNeeded();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ code: expect.stringMatching(PAIRING_CODE_RE) }),
      expect.stringContaining('pairing code'),
    );

    spy.mockClear();
    mintAdminToken(app);
    app.diContainer.cradle.authService.logBootPairingCodeIfNeeded();
    expect(spy).not.toHaveBeenCalled();
  });

  describe('pairing (HMAC two-step, docs/design/runner-and-helpdesk.md §5.2)', () => {
    async function mintCode(app: App, token: string): Promise<string> {
      const nc = generateNonce();
      const ch = (
        await app.inject({ method: 'POST', url: '/api/auth/pairing-challenge', payload: { nonce: nc } })
      ).json<{ challengeId: string; nonce: string }>();
      const proof = hmacProof(token, HMAC_CONTEXTS.pairing, 'client', ch.nonce, nc);
      const res = (
        await app.inject({ method: 'POST', url: '/api/auth/pairing-codes', payload: { challengeId: ch.challengeId, proof } })
      ).json<{ code: string }>();
      return res.code;
    }

    it('mints a code through the full challenge/response flow, and redeems it exactly once', async () => {
      const token = 'a'.repeat(32);
      app = await buildTestApp({ settings: { runner: { token } } });

      const nc = generateNonce();
      const challengeRes = await app.inject({ method: 'POST', url: '/api/auth/pairing-challenge', payload: { nonce: nc } });
      expect(challengeRes.statusCode).toBe(200);
      const challenge = challengeRes.json<{ challengeId: string; nonce: string; instanceId: string; proof: string }>();

      // instanceId matches GET /api/health (the squatter check pnpm office:pair/doctor perform).
      const health = (await app.inject({ url: '/api/health' })).json<{ instanceId: string }>();
      expect(challenge.instanceId).toBe(health.instanceId);
      const expectedServerProof = hmacProof(token, HMAC_CONTEXTS.pairing, 'server', nc, challenge.nonce, challenge.instanceId);
      expect(challenge.proof).toBe(expectedServerProof);

      const clientProof = hmacProof(token, HMAC_CONTEXTS.pairing, 'client', challenge.nonce, nc);
      const codeRes = await app.inject({
        method: 'POST',
        url: '/api/auth/pairing-codes',
        payload: { challengeId: challenge.challengeId, proof: clientProof },
      });
      expect(codeRes.statusCode).toBe(200);
      const { code } = codeRes.json<{ code: string; url: string; expiresAt: number }>();
      expect(code).toMatch(PAIRING_CODE_RE);

      const pair = await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code } });
      expect(pair.statusCode).toBe(200);
      const { token: adminToken } = pair.json<{ token: string; sessionId: string; expiresAt: number }>();
      expect((await app.inject({ url: '/api/auth/status', headers: { authorization: `Bearer ${adminToken}` } })).json().admin).toBe(true);

      // Replay: the same code again is refused.
      const replay = await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code } });
      expect(replay.statusCode).toBe(401);
    });

    it('refuses a reused challengeId and a proof computed for another challenge', async () => {
      const token = 'a'.repeat(32);
      app = await buildTestApp({ settings: { runner: { token } } });
      const nc = generateNonce();
      const { challengeId, nonce: ns } = (
        await app.inject({ method: 'POST', url: '/api/auth/pairing-challenge', payload: { nonce: nc } })
      ).json<{ challengeId: string; nonce: string }>();
      const proof = hmacProof(token, HMAC_CONTEXTS.pairing, 'client', ns, nc);

      const first = await app.inject({ method: 'POST', url: '/api/auth/pairing-codes', payload: { challengeId, proof } });
      expect(first.statusCode).toBe(200);
      const reused = await app.inject({ method: 'POST', url: '/api/auth/pairing-codes', payload: { challengeId, proof } });
      expect(reused.statusCode).toBe(401);

      // A second, fresh challenge, answered with a proof computed for the first one.
      const nc2 = generateNonce();
      const second = (
        await app.inject({ method: 'POST', url: '/api/auth/pairing-challenge', payload: { nonce: nc2 } })
      ).json<{ challengeId: string; nonce: string }>();
      const wrongProof = await app.inject({
        method: 'POST',
        url: '/api/auth/pairing-codes',
        payload: { challengeId: second.challengeId, proof },
      });
      expect(wrongProof.statusCode).toBe(401);
    });

    it('keeps at most 3 live codes, evicting the oldest first', async () => {
      const token = 'a'.repeat(32);
      app = await buildTestApp({ settings: { runner: { token } } });
      const c1 = await mintCode(app, token);
      const c2 = await mintCode(app, token);
      const c3 = await mintCode(app, token);
      void c2;
      void c3;
      const c4 = await mintCode(app, token);

      const evicted = await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: c1 } });
      expect(evicted.statusCode).toBe(401);
      const stillLive = await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: c4 } });
      expect(stillLive.statusCode).toBe(200);
    });

    it('pairing endpoints refuse any request carrying an Origin header', async () => {
      app = await buildTestApp({ settings: { runner: { token: 'a'.repeat(32) } } });
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/pairing-challenge',
        payload: { nonce: generateNonce() },
        headers: { origin: 'http://localhost:5173' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('pairing is disabled (401) when runner.token is empty', async () => {
      app = await buildTestApp();
      const res = await app.inject({ method: 'POST', url: '/api/auth/pairing-challenge', payload: { nonce: generateNonce() } });
      expect(res.statusCode).toBe(401);
    });

    it('M2: minting pairing-challenge requests is never rate-limited — only a failed proof counts', async () => {
      app = await buildTestApp({ settings: { runner: { token: 'a'.repeat(32) } } });
      for (let i = 0; i < 15; i++) {
        const res = await app.inject({ method: 'POST', url: '/api/auth/pairing-challenge', payload: { nonce: generateNonce() } });
        expect(res.statusCode).toBe(200);
      }
    });

    it('M2: repeated wrong proofs at /pairing-codes hit 429, but a correct proof still succeeds afterwards', async () => {
      const token = 'a'.repeat(32);
      app = await buildTestApp({ settings: { runner: { token } } });
      let last: number | undefined;
      for (let i = 0; i < 15; i++) {
        const nc = generateNonce();
        const { challengeId } = (
          await app.inject({ method: 'POST', url: '/api/auth/pairing-challenge', payload: { nonce: nc } })
        ).json<{ challengeId: string }>();
        // Schema-valid shape (43-char base64url, like a real proof) but wrong, so it reaches
        // `pairingCode()`'s own check instead of being rejected by request validation first.
        const res = await app.inject({ method: 'POST', url: '/api/auth/pairing-codes', payload: { challengeId, proof: generateNonce() } });
        last = res.statusCode;
      }
      expect(last).toBe(429);

      // The failure bucket is exhausted, but a CORRECT proof is never checked against it.
      const nc = generateNonce();
      const challenge = (
        await app.inject({ method: 'POST', url: '/api/auth/pairing-challenge', payload: { nonce: nc } })
      ).json<{ challengeId: string; nonce: string }>();
      const proof = hmacProof(token, HMAC_CONTEXTS.pairing, 'client', challenge.nonce, nc);
      const ok = await app.inject({ method: 'POST', url: '/api/auth/pairing-codes', payload: { challengeId: challenge.challengeId, proof } });
      expect(ok.statusCode).toBe(200);
    });

    it('M2 (lockout-DoS): repeated wrong /pair codes hit 429, but the real code still redeems successfully', async () => {
      const token = 'a'.repeat(32);
      app = await buildTestApp({ settings: { runner: { token } } });
      const realCode = await mintCode(app, token);

      let last: number | undefined;
      for (let i = 0; i < 15; i++) {
        const res = await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: 'AAAA-AAAA-AAAA' } });
        last = res.statusCode;
      }
      expect(last).toBe(429);

      // An attacker flooding /pair with wrong guesses must never be able to lock the real user out.
      const redeemed = await app.inject({ method: 'POST', url: '/api/auth/pair', payload: { code: realCode } });
      expect(redeemed.statusCode).toBe(200);
    });
  });

  describe('bootstrap (mode: same-origin)', () => {
    it('404s in the default pairing mode', async () => {
      app = await buildTestApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/bootstrap',
        headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('needs a present, allowed Origin; refuses cross-site and corsOrigins including "*"', async () => {
      app = await buildTestApp({ settings: { auth: { mode: 'same-origin' } } });
      const origins = app.diContainer.cradle.settings.get().server.corsOrigins;

      const noOrigin = await app.inject({ method: 'POST', url: '/api/auth/bootstrap', headers: { 'content-type': 'application/json' } });
      expect(noOrigin.statusCode).toBe(403);

      const crossSite = await app.inject({
        method: 'POST',
        url: '/api/auth/bootstrap',
        headers: { origin: origins[0] ?? '', 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' },
      });
      expect(crossSite.statusCode).toBe(403);

      const ok = await app.inject({
        method: 'POST',
        url: '/api/auth/bootstrap',
        headers: { origin: origins[0] ?? '', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      });
      expect(ok.statusCode).toBe(200);

      const wildcard = await buildTestApp({ settings: { auth: { mode: 'same-origin' }, server: { corsOrigins: ['*'] } } });
      try {
        const res = await wildcard.inject({
          method: 'POST',
          url: '/api/auth/bootstrap',
          headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
        });
        expect(res.statusCode).toBe(403);
      } finally {
        await wildcard.close();
      }
    });
  });

  describe('sessions', () => {
    it('enforces settings.auth.maxSessions by evicting the oldest-used session', async () => {
      app = await buildTestApp({ settings: { auth: { maxSessions: 2 } } });
      const t1 = mintAdminToken(app, 'one');
      await new Promise((r) => setTimeout(r, 2));
      const t2 = mintAdminToken(app, 'two');
      await new Promise((r) => setTimeout(r, 2));
      const t3 = mintAdminToken(app, 'three');

      expect(app.diContainer.cradle.authService.verify(t1).ok).toBe(false); // evicted
      expect(app.diContainer.cradle.authService.verify(t2).ok).toBe(true);
      expect(app.diContainer.cradle.authService.verify(t3).ok).toBe(true);
    });

    it('lists sessions with `current` set, and revoke("*") signs everyone out', async () => {
      app = await buildTestApp();
      const t1 = mintAdminToken(app, 'a');
      const t2 = mintAdminToken(app, 'b');
      const list = (
        await app.inject({ url: '/api/auth/sessions', headers: { authorization: `Bearer ${t1}` } })
      ).json<{ id: string; current: boolean }[]>();
      expect(list).toHaveLength(2);
      expect(list.find((s) => s.current)).toBeDefined();

      const revoke = await app.inject({
        method: 'POST',
        url: '/api/auth/sessions/*/revoke',
        headers: { authorization: `Bearer ${t1}`, 'content-type': 'application/json' },
      });
      expect(revoke.statusCode).toBe(200);
      expect(app.diContainer.cradle.authService.verify(t1).ok).toBe(false);
      expect(app.diContainer.cradle.authService.verify(t2).ok).toBe(false);
    });

    it("logout revokes only the caller's own session", async () => {
      app = await buildTestApp();
      const t1 = mintAdminToken(app, 'a');
      const t2 = mintAdminToken(app, 'b');
      await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { authorization: `Bearer ${t1}`, 'content-type': 'application/json' } });
      expect(app.diContainer.cradle.authService.verify(t1).ok).toBe(false);
      expect(app.diContainer.cradle.authService.verify(t2).ok).toBe(true);
    });
  });

  it('masks runner.token like server.hookToken in every settings response', async () => {
    app = await buildTestApp({ settings: { runner: { token: 'a'.repeat(32) } } });
    const rest = (await app.inject({ url: '/api/settings' })).json<{ runner: { token: string } }>();
    expect(rest.runner.token).not.toBe('super-secret');
    expect(rest.runner.token).toBe('********');
  });
});
