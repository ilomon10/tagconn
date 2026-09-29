import { describe, expect, it } from 'vitest';
import { RpcFailure } from '../src/errors.ts';
import { createRpcServer } from '../src/protocol.ts';
import type { Handlers } from '../src/supervisor.ts';

function setup(overrides: Partial<Record<string, (p: unknown) => unknown>> = {}) {
  const out: Record<string, unknown>[] = [];
  const err: string[] = [];
  const handlers = {
    'app.info': () => ({ hello: 'world' }),
    'service.start': (p: unknown) => ({ started: p }),
    'config.get': () => {
      throw new RpcFailure('busy', 'nope', 'try later');
    },
    'config.set': () => {
      throw new Error('kaboom');
    },
    'setup.check': async () => {
      await new Promise((r) => setTimeout(r, 20));
      return [];
    },
    ...overrides,
  } as unknown as Handlers;
  const rpc = createRpcServer({ handlers, write: (m) => out.push(m as Record<string, unknown>), logErr: (l) => err.push(l) });
  return { rpc, out, err };
}

describe('rpc protocol', () => {
  it('answers a valid request exactly once, with the same id', async () => {
    const { rpc, out } = setup();
    await rpc.handleLine(JSON.stringify({ id: 7, method: 'app.info' }));
    expect(out).toEqual([{ id: 7, ok: true, result: { hello: 'world' } }]);
  });

  it('validates params with the method schema', async () => {
    const { rpc, out } = setup();
    await rpc.handleLine(JSON.stringify({ id: 1, method: 'service.start', params: { id: 'nginx' } }));
    await rpc.handleLine(JSON.stringify({ id: 2, method: 'service.start', params: { id: 'server' } }));
    expect(out[0]).toMatchObject({ id: 1, ok: false, error: { code: 'invalid_request' } });
    expect(out[1]).toEqual({ id: 2, ok: true, result: { started: { id: 'server' } } });
  });

  it('rejects an unknown method', async () => {
    const { rpc, out } = setup();
    await rpc.handleLine(JSON.stringify({ id: 3, method: 'rm.rf' }));
    await rpc.handleLine(JSON.stringify({ id: 4, method: 'toString' }));
    expect(out).toEqual([
      { id: 3, ok: false, error: { code: 'unknown_method', message: expect.stringContaining('rm.rf') } },
      { id: 4, ok: false, error: { code: 'unknown_method', message: expect.stringContaining('toString') } },
    ]);
  });

  it('survives malformed lines: invalid_request when an id can be read, stderr only otherwise', async () => {
    const { rpc, out, err } = setup();
    await rpc.handleLine('this is not json');
    await rpc.handleLine('{"id": 9, "method": "app.info"');
    await rpc.handleLine('{"id": "x", "method": 1}');
    await rpc.handleLine('{"id": 5}');
    await rpc.handleLine('[1,2,3]');
    await rpc.handleLine('');
    expect(out).toEqual([
      { id: 9, ok: false, error: { code: 'invalid_request', message: expect.any(String) } },
      { id: 5, ok: false, error: { code: 'invalid_request', message: expect.any(String) } },
    ]);
    expect(err.length).toBe(5);
    // still alive
    await rpc.handleLine(JSON.stringify({ id: 10, method: 'app.info' }));
    expect(out[2]).toMatchObject({ id: 10, ok: true });
  });

  it('maps RpcFailure to its code and hint, and other errors to internal (no stack on the wire)', async () => {
    const { rpc, out, err } = setup();
    await rpc.handleLine(JSON.stringify({ id: 1, method: 'config.get' }));
    await rpc.handleLine(JSON.stringify({ id: 2, method: 'config.set', params: {} }));
    expect(out[0]).toEqual({ id: 1, ok: false, error: { code: 'busy', message: 'nope', hint: 'try later' } });
    expect(out[1]).toEqual({ id: 2, ok: false, error: { code: 'internal', message: 'kaboom' } });
    expect(err.join('\n')).toContain('kaboom');
  });

  it('answers concurrent requests once each, even out of order', async () => {
    const { rpc, out } = setup();
    void rpc.handleLine(JSON.stringify({ id: 1, method: 'setup.check' }));
    void rpc.handleLine(JSON.stringify({ id: 2, method: 'app.info' }));
    await rpc.idle();
    expect(out.map((m) => m.id).sort()).toEqual([1, 2]);
    expect(out.map((m) => m.id)[0]).toBe(2);
  });
});
