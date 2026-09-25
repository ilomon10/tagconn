import { useMemo, useState } from 'react';
import { onFloor, useOfficeStore } from '../../stores/officeStore';
import { useRoleLookup } from '../../lib/hooks';
import { clock, shortId } from '../../lib/format';
import { api } from '../../lib/api';
import { Button, Dot, Input, Select } from '../../components/ui';

export function EventLog() {
  const events = useOfficeStore((s) => s.events);
  const agents = useOfficeStore((s) => s.agents);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const connection = useOfficeStore((s) => s.connection);
  const prependEvents = useOfficeStore((s) => s.prependEvents);
  const lookup = useRoleLookup();
  const [agentFilter, setAgentFilter] = useState('');
  const [hookFilter, setHookFilter] = useState('');
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const floorEvents = useMemo(() => events.filter((e) => onFloor(selected, e.projectId)), [events, selected]);
  const agentIds = useMemo(() => [...new Set(floorEvents.map((e) => e.agentId))], [floorEvents]);
  const hookEvents = useMemo(() => [...new Set(floorEvents.map((e) => e.hookEvent))].sort(), [floorEvents]);
  const needle = text.trim().toLowerCase();
  const rows = useMemo(
    () =>
      floorEvents
        .filter(
          (e) =>
            (!agentFilter || e.agentId === agentFilter) &&
            (!hookFilter || e.hookEvent === hookFilter) &&
            (!needle || `${e.summary} ${e.toolName ?? ''}`.toLowerCase().includes(needle)),
        )
        .reverse(),
    [floorEvents, agentFilter, hookFilter, needle],
  );

  const agentLabel = (id: string) => {
    const a = agents[id];
    if (!a) return shortId(id);
    const r = lookup(a.role);
    return a.description ? `${r.title} · ${a.description}` : r.title;
  };

  const loadOlder = async () => {
    const oldest = floorEvents[0];
    setLoading(true);
    setLoadError(null);
    try {
      const older = await api.events({ projectId: selected === '*' ? undefined : selected, limit: 200, before: oldest?.id });
      prependEvents(older);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select className="w-64" value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} aria-label="Filter by agent">
          <option value="">All agents</option>
          {agentIds.map((id) => (
            <option key={id} value={id}>
              {agentLabel(id)}
            </option>
          ))}
        </Select>
        <Select className="w-44" value={hookFilter} onChange={(e) => setHookFilter(e.target.value)} aria-label="Filter by hook event">
          <option value="">All hook events</option>
          {hookEvents.map((h) => (
            <option key={h}>{h}</option>
          ))}
        </Select>
        <Input className="w-56" placeholder="Search summary / tool…" value={text} onChange={(e) => setText(e.target.value)} />
        <span className="text-[11px] text-ink-400">
          {rows.length} of {floorEvents.length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {loadError && <span className="text-[11px] text-red-300">{loadError}</span>}
          <Button onClick={loadOlder} disabled={loading || connection !== 'connected'}>
            {loading ? 'Loading…' : 'Load older'}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-ink-700 bg-ink-850">
        <table className="w-full table-fixed text-left text-[11px]">
          <thead className="sticky top-0 bg-ink-800 text-ink-400">
            <tr>
              <th className="w-20 px-3 py-1.5 font-medium">Time</th>
              <th className="w-56 px-2 py-1.5 font-medium">Agent</th>
              <th className="w-36 px-2 py-1.5 font-medium">Event</th>
              <th className="w-32 px-2 py-1.5 font-medium">Tool</th>
              <th className="px-2 py-1.5 font-medium">Summary</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700/50">
            {rows.map((e) => {
              const a = agents[e.agentId];
              const r = lookup(a?.role);
              return (
                <tr key={e.id} className="hover:bg-ink-800/60">
                  <td className="px-3 py-1 font-pixel text-ink-400">{clock(e.ts)}</td>
                  <td className="truncate px-2 py-1">
                    <span className="inline-flex items-center gap-1.5">
                      <Dot color={r.color} className="size-2" />
                      <span className="truncate">{agentLabel(e.agentId)}</span>
                    </span>
                  </td>
                  <td className="px-2 py-1 text-ink-300">{e.hookEvent}</td>
                  <td className="truncate px-2 py-1 font-pixel text-ink-300">{e.toolName ?? ''}</td>
                  <td className="truncate px-2 py-1 text-ink-100" title={e.summary}>
                    {e.summary}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="p-6 text-center text-xs text-ink-400">No events match.</p>}
      </div>
    </div>
  );
}
