import { useEffect, useMemo, useRef, useState } from 'react';
import { SERVICE_IDS, type ServiceId } from '@tagconn/shared';
import { filterLogs, formatLogLine, type AppState } from '../lib/state';
import { Button, Dialog } from './ui';

type Filter = ServiceId | 'supervisor' | 'all';

export function LogsDrawer({ logs, onLoad, onCopy, onClose }: { logs: AppState['logs']; onLoad: () => void; onCopy: (text: string) => void; onClose: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLPreElement>(null);
  useEffect(onLoad, [onLoad]);
  const lines = useMemo(() => filterLogs(logs, filter), [logs, filter]);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);
  const text = lines.map(formatLogLine).join('\n');
  return (
    <Dialog title="Logs" side onClose={onClose}>
      <div className="flex h-full flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-ink-300" htmlFor="log-filter">
            Service
          </label>
          <select id="log-filter" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} className="rounded-md border border-ink-600 bg-ink-900 px-2 py-1 text-sm">
            <option value="all">All</option>
            {[...SERVICE_IDS, 'supervisor' as const].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" className="accent-[#f5c07a]" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow
          </label>
          <Button onClick={() => onCopy(text)} disabled={!text}>
            Copy
          </Button>
        </div>
        <pre ref={box} tabIndex={0} aria-label="Log output" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md bg-ink-950 p-2 font-pixel text-xs leading-relaxed">
          {text || 'No log lines yet.'}
        </pre>
      </div>
    </Dialog>
  );
}
