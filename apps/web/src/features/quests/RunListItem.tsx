import type { Run, RunStatus } from '@tagconn/shared';
import { useNow } from '../../lib/hooks';
import { clock, elapsed, formatTokens } from '../../lib/format';
import { Badge, cx } from '../../components/ui';
import { sumRunUsage } from './usage';

/** Quest card summary row (docs/design/runner-and-helpdesk.md section 3: "status, elapsed time, …
 *  and a result card"). The full transcript lives in `RunDetailPanel`; this is just the list row. */

const STATUS_STYLE: Record<RunStatus, string> = {
  queued: 'bg-ink-700 text-ink-300',
  dispatched: 'bg-sky-900/60 text-sky-200',
  running: 'bg-amber-900/60 text-amber-200 motion-safe:animate-pulse',
  succeeded: 'bg-emerald-900/60 text-emerald-200',
  failed: 'bg-red-900/60 text-red-200',
  stopped: 'bg-ink-700 text-ink-300',
  timeout: 'bg-red-900/60 text-red-200',
  rejected: 'bg-red-900/60 text-red-200',
  lost: 'bg-fuchsia-900/60 text-fuchsia-200',
};

export function RunListItem({ run, floorName, active, onOpen }: { run: Run; floorName?: string; active: boolean; onOpen: () => void }) {
  const now = useNow(1000);
  const started = run.startedAt ?? run.createdAt;
  const ended = run.endedAt ?? now;
  const usage = run.result?.usage;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className={cx(
          'w-full rounded-md border px-3 py-2 text-left transition',
          active ? 'border-cozy bg-ink-800' : 'border-ink-700 bg-ink-850 hover:border-ink-600',
        )}
      >
        <div className="flex items-center gap-2">
          <Badge className={STATUS_STYLE[run.status]}>{run.status}</Badge>
          {floorName && <span className="truncate text-[11px] text-ink-400">{floorName}</span>}
          <span className="ml-auto shrink-0 font-pixel text-[10px] text-ink-500">{clock(run.createdAt)}</span>
        </div>
        <p className="mt-1 truncate text-xs text-ink-100">{run.prompt}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-400">
          <Badge className="bg-ink-700 text-ink-300">{run.model}</Badge>
          <Badge className="bg-ink-700 text-ink-300">{run.permissionMode}</Badge>
          <span className="font-pixel">{elapsed(started, ended)}</span>
          {usage && <span>{formatTokens(sumRunUsage(usage))} tok</span>}
          {run.result?.costUsd !== undefined && <span>${run.result.costUsd.toFixed(3)}</span>}
        </div>
      </button>
    </li>
  );
}
