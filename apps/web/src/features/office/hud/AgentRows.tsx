import type { Agent } from '@tagconn/shared';
import { useThemedRoleLookup } from '../../../lib/hooks';
import { elapsed, formatTokens } from '../../../lib/format';
import { contextRatio, totalTokens } from '../../../lib/tokens';
import { ALL_FLOORS, useOfficeStore } from '../../../stores/officeStore';
import { Badge, Dot, cx } from '../../../components/ui';
import { STATUS_STYLE, statusLabel } from './status';
import { usePortraitLook } from './usePortraitLook';

/** One agent in the phone tray's list: title, status, time, tools and a context bar. */
export function AgentRow({ agent, selected, onSelect, now, offCanvas }: { agent: Agent; selected: boolean; onSelect: () => void; now: number; offCanvas: boolean }) {
  const lookup = useThemedRoleLookup();
  const { hero } = usePortraitLook(agent);
  // Same title the character's name tag and the card show: hero title, edited role title, else the
  // title of the style of THIS agent's floor (the Multiverse mixes floors).
  const role = lookup(agent.role, { projectId: agent.projectId, hero });
  const project = useOfficeStore((s) => s.projects[agent.projectId]?.name);
  const multiFloor = useOfficeStore((s) => s.selectedProjectId === ALL_FLOORS);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={cx(
          'w-full rounded-lg border px-2.5 py-2 text-left transition-colors coarse:min-h-11',
          selected ? 'border-cozy/60 bg-ink-700' : 'border-transparent hover:bg-ink-800',
          (agent.status === 'done' || offCanvas) && 'opacity-60',
        )}
      >
        <div className="flex items-center gap-2">
          <Dot color={role.color} />
          <span className="truncate text-xs font-semibold text-ink-100">{hero ? hero.name : role.themedTitle}</span>
          {hero && <span className="truncate text-[10px] text-ink-300">{role.themedTitle}</span>}
          {!hero && role.themedTitle !== role.title && <span className="truncate text-[10px] text-ink-300">{role.title}</span>}
          {agent.isMain && <Badge>main</Badge>}
          {offCanvas && <Badge className="bg-ink-700 text-ink-300">off canvas</Badge>}
          <span className="ml-auto shrink-0 font-pixel text-[10px] text-ink-300">{elapsed(agent.startedAt, agent.endedAt ?? now)}</span>
        </div>
        {agent.description && <div className="mt-0.5 truncate pl-4.5 text-[11px] text-ink-300">{agent.description}</div>}
        <div className="mt-1 flex items-center gap-1.5 pl-4.5">
          <Badge className={STATUS_STYLE[agent.status]}>{statusLabel(agent)}</Badge>
          <span className="font-pixel text-[10px] text-ink-300">{agent.toolCount} tools</span>
          {multiFloor && project && <span className="truncate text-[10px] text-ink-300">· {project}</span>}
        </div>
        {agent.usage && (
          <div className="mt-1 flex items-center gap-1.5 pl-4.5">
            <span className="shrink-0 font-pixel text-[10px] text-ink-300">{formatTokens(totalTokens(agent.usage))} tok</span>
            <div className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-ink-700">
              <div className="h-full rounded-full bg-cozy/70" style={{ width: `${contextRatio(agent.usage) * 100}%` }} />
            </div>
          </div>
        )}
      </button>
    </li>
  );
}
