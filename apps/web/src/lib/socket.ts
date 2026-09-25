import { io, type Socket } from 'socket.io-client';
import {
  OFFICE_NAMESPACE,
  type ClientToServerEvents,
  type HeroCreate,
  type HeroListRequest,
  type HeroPatch,
  type LayoutAssign,
  type OfficeLayoutInput,
  type ServerToClientEvents,
} from '@tagconn/shared';

export type OfficeSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: OfficeSocket | null = null;

/** Lazily created singleton; same origin (vite/nginx proxy `/socket.io`). Not connected until `.connect()`. */
export function getSocket(): OfficeSocket {
  if (!socket) {
    socket = io(OFFICE_NAMESPACE, {
      path: '/socket.io',
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
}

type C2S = ClientToServerEvents;
type AckPayload<F> = F extends (...args: [...infer _A, infer Cb]) => void
  ? Cb extends (res: infer R) => void
    ? R extends { ok: true; data: infer D }
      ? D
      : never
    : never
  : never;
type AckArgs<F> = F extends (...args: [...infer A, infer _Cb]) => void ? A : never;

export class AckError extends Error {}

/** Emit a client→server event and resolve with the ack's `data` (rejects on `{ok:false}` or timeout). */
export function emitWithAck<E extends keyof C2S>(event: E, ...args: AckArgs<C2S[E]>): Promise<AckPayload<C2S[E]>> {
  const s = getSocket();
  return new Promise((resolve, reject) => {
    if (!s.connected) {
      reject(new AckError('Not connected to the office server'));
      return;
    }
    const timer = setTimeout(() => reject(new AckError(`Timed out waiting for ${String(event)}`)), 10_000);
    const cb = (res: { ok: true; data: unknown } | { ok: false; error: string }) => {
      clearTimeout(timer);
      if (res && res.ok) resolve(res.data as AckPayload<C2S[E]>);
      else reject(new AckError(res?.error ?? 'Unknown server error'));
    };
    // socket.io's typed emit cannot express "args + trailing ack" generically; the public signature above is typed.
    (s.emit as unknown as (ev: string, ...rest: unknown[]) => void)(event, ...args, cb);
  });
}

/** M7 office editor: typed wrappers around the `layouts:*` acked events (guild-hall.md section 2). */
export const layoutSocket = {
  list: () => emitWithAck('layouts:list'),
  get: (id: string) => emitWithAck('layouts:get', id),
  save: (layout: OfficeLayoutInput) => emitWithAck('layouts:save', layout),
  delete: (id: string) => emitWithAck('layouts:delete', id),
  assign: (req: LayoutAssign) => emitWithAck('layouts:assign', req),
};

/** M8 8i heroes: typed wrappers around the `heroes:*` acked events (living-office.md section 2.2/3.3). */
export const heroSocket = {
  list: (req: HeroListRequest = {}) => emitWithAck('heroes:list', req),
  create: (req: HeroCreate) => emitWithAck('heroes:create', req),
  update: (id: string, patch: HeroPatch) => emitWithAck('heroes:update', { id, patch }),
  reset: (id: string) => emitWithAck('heroes:reset', id),
  delete: (id: string) => emitWithAck('heroes:delete', id),
};
