import { describe, expect, it, vi } from 'vitest';
import { createRpc, RpcClientError, toRpcError } from './rpc';

const cfg = { runMode: 'native', serverPort: 4317, allowedProjectDirs: [], attributionReadme: false, autoStartServices: true, openOfficeOnStart: true, dataDir: null };

describe('rpc client', () => {
  it('invokes the rpc command with validated params and returns the parsed result', async () => {
    const invoke = vi.fn().mockResolvedValue(cfg);
    const out = await createRpc(invoke)('config.set', { serverPort: 4400 });
    expect(invoke).toHaveBeenCalledWith('rpc', { method: 'config.set', params: { serverPort: 4400 } });
    expect(out.serverPort).toBe(4317);
  });

  it('sends {} when a method has no params', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    await createRpc(invoke)('setup.check');
    expect(invoke).toHaveBeenCalledWith('rpc', { method: 'setup.check', params: {} });
  });

  it('rejects invalid params before invoking', async () => {
    const invoke = vi.fn();
    await expect(createRpc(invoke)('config.set', { serverPort: 80 })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('turns a supervisor RpcError into RpcClientError with its hint', async () => {
    const invoke = vi.fn().mockRejectedValue({ code: 'port_in_use', message: 'Port 4317 is busy', hint: 'Use port 4318' });
    const err = await createRpc(invoke)('service.start', { id: 'server' }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcClientError);
    expect(err).toMatchObject({ code: 'port_in_use', message: 'Port 4317 is busy', hint: 'Use port 4318' });
  });

  it('maps sidecar_down, strings and unknown values', () => {
    expect(toRpcError({ code: 'sidecar_down', message: 'gone' }).code).toBe('sidecar_down');
    expect(toRpcError('boom')).toMatchObject({ code: 'internal', message: 'boom' });
    expect(toRpcError(42).code).toBe('internal');
  });

  it('flags a response that does not match the contract', async () => {
    const invoke = vi.fn().mockResolvedValue({ nope: true });
    await expect(createRpc(invoke)('service.status')).rejects.toMatchObject({ code: 'internal' });
  });
});
