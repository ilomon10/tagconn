import type { Agent } from '@tagconn/shared';
import { useNow, useRoleLookup } from '../../lib/hooks';
import { elapsed, formatTokens } from '../../lib/format';
import { contextRatio, totalTokens } from '../../lib/tokens';
import { Badge, Dot, Empty, cx } from '../../components/ui';
import { useOfficeStore } from '../../stores/officeStore';

const STATUS_STYLE: Record<Agent['status'], string> = {
  active: 'bg-emerald-500/15 text-emerald-300',
  waiting: 'bg-amber-500/20 text-amber-300',
  blocked: 'bg-red-500/20 text-red-300',
  done: 'bg-ink-700 text-ink-400',
};

function RosterItem({ agent, selected, onSelect, now }: { agent: Agent; selected: boolean; onSelect: () => void; now: number }) {
  const lookup = useRoleLookup();
  const role = lookup(agent.role);
  const project = useOfficeStore((s) => s.projects[agent.projectId]?.name);
  const multiFloor = useOfficeStore((s) => s.selectedProjectId === '*');
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cx(
          'w-full rounded-lg border px-2.5 py-2 text-left transition',
          selected ? 'border-cozy/60 bg-ink-700' : 'border-transparent hover:bg-ink-800',
          agent.status === 'done' && 'opacity-60',
        )}
      >
        <div className="flex items-center gap-2">
          <Dot color={role.color} />
          <span className="truncate text-xs font-semibold text-ink-100">{role.title}</span>
          {agent.isMain && <Badge>main</Badge>}
          <span className="ml-auto shrink-0 font-pixel text-[10px] text-ink-400">{elapsed(agent.startedAt, agent.endedAt ?? now)}</span>
        </div>
        {agent.description && <div className="mt-0.5 truncate pl-4.5 text-[11px] text-ink-300">{agent.description}</div>}
        <div className="mt-1 flex items-center gap-1.5 pl-4.5">
          <Badge className={STATUS_STYLE[agent.status]}>{agent.status === 'active' ? agent.activity : agent.status}</Badge>
          <span className="font-pixel text-[10px] text-ink-400">{agent.toolCount} tools</span>
          {multiFloor && project && <span className="truncate text-[10px] text-ink-400">· {project}</span>}
        </div>
        {agent.usage && (
          <div className="mt-1 flex items-center gap-1.5 pl-4.5">
            <span className="shrink-0 font-pixel text-[10px] text-ink-400">{formatTokens(totalTokens(agent.usage))} tok</span>
            <div
              className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-ink-700"
              title={`${formatTokens(agent.usage.contextTokens)} context tokens${agent.usage.model ? ` · ${agent.usage.model}` : ''}`}
            >
              <div className="h-full rounded-full bg-cozy/70" style={{ width: `${contextRatio(agent.usage) * 100}%` }} />
            </div>
          </div>
        )}
        {agent.bubble && <div className="mt-1 truncate pl-4.5 text-[11px] italic text-ink-300">“{agent.bubble}”</div>}
      </button>
    </li>
  );
}

export function Roster({ agents, selectedId, onSelect }: { agents: Agent[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const now = useNow();
  const active = agents.filter((a) => a.status !== 'done').length;
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-ink-700 bg-ink-850">
      <header className="flex items-center justify-between border-b border-ink-700 px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide">Roster</h2>
        <span className="text-[11px] text-ink-400">
          {active} working · {agents.length} total
        </span>
      </header>
      {agents.length === 0 ? (
        <Empty>No one is in the office yet.</Empty>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {agents.map((a) => (
            <RosterItem key={a.id} agent={a} now={now} selected={a.id === selectedId} onSelect={() => onSelect(a.id)} />
          ))}
        </ul>
      )}
    </aside>
  );
}
