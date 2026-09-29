import { DESKTOP_METHODS, RpcErrorSchema, type DesktopMethod, type DesktopParams, type DesktopResult, type RpcErrorCode } from '@tagconn/shared';

/** What the Rust `rpc` command rejects with (a `RpcError`, or a transport failure with code `internal`). */
export class RpcClientError extends Error {
  readonly code: RpcErrorCode | 'sidecar_down';
  readonly hint?: string;
  constructor(code: RpcClientError['code'], message: string, hint?: string) {
    super(message);
    this.name = 'RpcClientError';
    this.code = code;
    this.hint = hint;
  }
}

/** Anything the transport can throw -> one RpcClientError. */
export function toRpcError(e: unknown): RpcClientError {
  if (e instanceof RpcClientError) return e;
  const parsed = RpcErrorSchema.safeParse(e);
  if (parsed.success) return new RpcClientError(parsed.data.code, parsed.data.message, parsed.data.hint);
  if (e && typeof e === 'object' && 'code' in e && (e as { code: unknown }).code === 'sidecar_down') {
    const m = e as { message?: unknown; hint?: unknown };
    return new RpcClientError('sidecar_down', typeof m.message === 'string' ? m.message : 'The service manager is not running.', typeof m.hint === 'string' ? m.hint : undefined);
  }
  return new RpcClientError('internal', e instanceof Error ? e.message : typeof e === 'string' ? e : 'Unknown error');
}

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export type Rpc = <M extends DesktopMethod>(method: M, ...params: {} extends DesktopParams<M> ? [params?: DesktopParams<M>] : [params: DesktopParams<M>]) => Promise<DesktopResult<M>>;

/**
 * Typed client over the `rpc` tauri command. Params are validated before they leave the UI and the
 * result against the contract's schema, so a supervisor/UI version mismatch shows as an error, not as `undefined` fields.
 */
export function createRpc(invoke: Invoke): Rpc {
  return (async (method: DesktopMethod, params?: unknown) => {
    const spec = DESKTOP_METHODS[method];
    const checked = spec.params.safeParse(params ?? {});
    if (!checked.success) throw new RpcClientError('invalid_request', `Invalid parameters for ${method}: ${checked.error.issues[0]?.message ?? 'bad shape'}`);
    let raw: unknown;
    try {
      raw = await invoke('rpc', { method, params: checked.data });
    } catch (e) {
      throw toRpcError(e);
    }
    const result = spec.result.safeParse(raw);
    if (!result.success) throw new RpcClientError('internal', `Unexpected ${method} response from the service manager.`, 'The app and its service manager may be different versions; reinstall the app.');
    return result.data;
  }) as Rpc;
}
