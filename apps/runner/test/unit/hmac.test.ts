import { describe, expect, it } from 'vitest';
import { expectedServerProof, hmacProof, randomNonce, runnerProof, verifyProof } from '../../src/hmac.js';

describe('hmac', () => {
  it('randomNonce produces distinct 32-byte base64url strings', () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('verifyProof accepts a matching proof and rejects a tampered one', () => {
    const token = 'a'.repeat(32);
    const nr = randomNonce();
    const ns = randomNonce();
    const serverProof = expectedServerProof(token, nr, ns);
    expect(verifyProof(serverProof, serverProof)).toBe(true);
    expect(verifyProof(serverProof, runnerProof(token, ns, nr))).toBe(false);
  });

  it('verifyProof never throws on a length mismatch or garbage input', () => {
    expect(verifyProof('short', 'a-completely-different-length-string-here')).toBe(false);
    expect(verifyProof('', '')).toBe(true);
  });

  it('role separation prevents reflecting one side\'s proof as the other\'s', () => {
    const token = 'b'.repeat(32);
    const nr = randomNonce();
    const ns = randomNonce();
    const server = expectedServerProof(token, nr, ns);
    const runner = runnerProof(token, ns, nr);
    expect(server).not.toBe(runner);
  });

  it('a wrong token produces a different proof', () => {
    const nr = randomNonce();
    const ns = randomNonce();
    const p1 = hmacProof('token-one-aaaaaaaaaaaaaaaaaaaaaa', 'tagconn-runner-v1', 'server', nr, ns);
    const p2 = hmacProof('token-two-bbbbbbbbbbbbbbbbbbbbbb', 'tagconn-runner-v1', 'server', nr, ns);
    expect(p1).not.toBe(p2);
  });
});
