import type { ServiceId, ServiceStatus } from '@tagconn/shared';
import { lightFor } from '../lib/state';
import { Button, StatusLight } from './ui';

export const SERVICE_LABELS: Record<ServiceId, string> = { server: 'Server', runner: 'Runner', docker: 'Docker (server + web)' };

interface Props {
  id: ServiceId;
  status: ServiceStatus | undefined;
  busy: (key: string) => boolean;
  onOp: (id: ServiceId, op: 'start' | 'stop' | 'restart') => void;
}

export function ServiceRow({ id, status, busy, onOp }: Props) {
  const state = status?.state ?? 'stopped';
  const working = busy(`${id}:start`) || busy(`${id}:stop`) || busy(`${id}:restart`);
  const canStart = state === 'stopped' || state === 'crashed';
  const canStop = state === 'running' || state === 'starting';
  return (
    <li aria-label={SERVICE_LABELS[id]} className="rounded-lg border border-ink-700 bg-ink-850 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-32 flex-1">
          <h3 className="text-sm font-semibold">{SERVICE_LABELS[id]}</h3>
          <StatusLight light={lightFor(status?.state)} label={state} />
        </div>
        <div className="text-xs text-ink-300">
          Restarts: <span className="font-semibold text-ink-100">{status?.restarts ?? 0}</span>
          {status?.pid !== undefined && <span> · pid {status.pid}</span>}
        </div>
        <div className="flex gap-2">
          <Button variant="primary" disabled={!canStart || working} onClick={() => onOp(id, 'start')} aria-label={`Start ${SERVICE_LABELS[id]}`}>
            Start
          </Button>
          <Button disabled={!canStop || working} onClick={() => onOp(id, 'stop')} aria-label={`Stop ${SERVICE_LABELS[id]}`}>
            Stop
          </Button>
          <Button disabled={state === 'unavailable' || state === 'stopped' || working} onClick={() => onOp(id, 'restart')} aria-label={`Restart ${SERVICE_LABELS[id]}`}>
            Restart
          </Button>
        </div>
      </div>
      {status?.lastError && (
        <p className="mt-2 whitespace-pre-wrap rounded bg-ink-900 px-2 py-1.5 text-xs text-amber-200">{status.lastError}</p>
      )}
    </li>
  );
}
