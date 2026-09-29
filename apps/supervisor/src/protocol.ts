import { DESKTOP_METHODS, RpcRequestSchema, type DesktopMethod, type RpcError, type RpcResponse } from '@tagconn/shared';
import { RpcFailure } from './errors.ts';
import type { Handlers } from './supervisor.ts';

export interface RpcServerOptions {
  handlers: Handlers;
  /** Writes one protocol message (a JSON object) as one line to stdout. */
  write: (message: object) => void;
  /** Diagnostics: stderr only, never stdout. */
  logErr: (line: string) => void;
}

export interface RpcServer {
  /** Handles one input line. Resolves after the response (if any) was written. */
  handleLine: (line: string) => Promise<void>;
  /** Requests still being handled. */
  idle: () => Promise<void>;
}

const isMethod = (m: string): m is DesktopMethod => Object.hasOwn(DESKTOP_METHODS, m);

/** A JSON-looking line that isn't valid JSON can still carry a usable id. */
function sniffId(line: string): number | undefined {
  const m = /"id"\s*:\s*(-?\d{1,15})\s*[,}]/.exec(line);
  return m ? Number(m[1]) : undefined;
}

/**
 * Newline-delimited JSON-RPC (docs/design/desktop.md, packages/shared/src/desktop.ts): every request gets
 * exactly one response, with the same id, whatever happens. Malformed input never throws or kills the loop.
 */
export function createRpcServer(opts: RpcServerOptions): RpcServer {
  const inflight = new Set<Promise<void>>();

  const respond = (res: RpcResponse) => {
    try {
      opts.write(res);
    } catch (err) {
      opts.logErr(`could not write the response to request ${res.id}: ${(err as Error).message}`);
    }
  };
  const fail = (id: number, error: RpcError) => respond({ id, ok: false, error });

  async function dispatch(id: number, method: DesktopMethod, rawParams: unknown): Promise<void> {
    const parsed = DESKTOP_METHODS[method].params.safeParse(rawParams ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      fail(id, { code: 'invalid_request', message: `Invalid params for ${method}: ${issue ? `${issue.path.join('.') || 'params'}: ${issue.message}` : 'unknown'}` });
      return;
    }
    try {
      const handler = opts.handlers[method] as (p: unknown) => Promise<unknown> | unknown;
      respond({ id, ok: true, result: await handler(parsed.data) });
    } catch (err) {
      if (err instanceof RpcFailure) {
        fail(id, err.toRpcError());
      } else {
        // The stack stays on stderr; the peer gets the message.
        opts.logErr(`${method} failed: ${(err as Error).stack ?? String(err)}`);
        fail(id, { code: 'internal', message: (err as Error).message || 'Internal error.' });
      }
    }
  }

  async function handleLine(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      const id = sniffId(text);
      opts.logErr(`ignored a malformed line (not JSON): ${text.slice(0, 200)}`);
      if (id !== undefined) fail(id, { code: 'invalid_request', message: 'The request is not valid JSON.' });
      return;
    }
    const req = RpcRequestSchema.safeParse(json);
    if (!req.success) {
      const id = (json as { id?: unknown } | null)?.id;
      opts.logErr(`ignored an invalid request: ${text.slice(0, 200)}`);
      if (typeof id === 'number' && Number.isInteger(id)) fail(id, { code: 'invalid_request', message: 'The request must be {"id": <integer>, "method": <string>, "params"?: <object>}.' });
      return;
    }
    const { id, method, params } = req.data;
    if (!isMethod(method)) {
      fail(id, { code: 'unknown_method', message: `Unknown method "${method}".` });
      return;
    }
    const p = dispatch(id, method, params);
    inflight.add(p);
    try {
      await p;
    } finally {
      inflight.delete(p);
    }
  }

  return {
    handleLine,
    idle: async () => {
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
