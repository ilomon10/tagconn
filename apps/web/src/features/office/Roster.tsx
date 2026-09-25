import { useRef, useState } from 'react';
import type { Agent } from '@tagconn/shared';
import { useNow, useThemedRoleLookup } from '../../lib/hooks';
import { elapsed, formatTokens } from '../../lib/format';
import { contextRatio, totalTokens } from '../../lib/tokens';
import { resolveCast } from '../../game/cast';
import { Badge, Checkbox, Dot, Empty, cx } from '../../components/ui';
import { ALL_FLOORS, useOfficeStore } from '../../stores/officeStore';
import { useHeroStore } from '../../stores/heroStore';
import { useSettingsStore } from '../../stores/settingsStore';

const STATUS_STYLE: Record<Agent['status'], string> = {
  active: 'bg-emerald-500/15 text-emerald-300',
  waiting: 'bg-amber-500/20 text-amber-300',
  blocked: 'bg-red-500/20 text-red-300',
  done: 'bg-ink-700 text-ink-400',
};

/**
 * Which of `agents` are "off canvas" right now — idle and unbound, still inside the hero-bind grace
 * window, collapsed into a Guild Master's session chip, or pushed past the character cap (M8 8b/8c,
 * `game/cast.ts`'s `resolveCast`). Kept local to the roster rather than the scene: the roster only
 * needs the resulting *set* of hidden ids, not the scene's stateful walk/rest/leave timers, and this
 * way the badge stays accurate even before W7a wires the scene itself up to `resolveCast`.
 *
 * `prevPrimary` (the Guild Master hysteresis, section 5) is kept across renders via a ref, seeded
 * each call with any pins from `pinnedPrimary` — the same "keep it across calls" convention
 * `cast.ts` documents for its scene caller.
 */
function useHiddenAgentIds(agents: Agent[], now: number): ReadonlySet<string> {
  const heroes = useHeroStore((s) => s.heroes);
  const sessions = useOfficeStore((s) => s.sessions);
  const pinnedPrimary = useOfficeStore((s) => s.pinnedPrimary);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const office = useSettingsStore((s) => s.settings.office);
  const heroesEnabled = useSettingsStore((s) => s.settings.heroes.enabled);
  const prevPrimary = useRef<Map<string, string>>(new Map());

  const seeded = new Map(prevPrimary.current);
  for (const [projectId, agentId] of Object.entries(pinnedPrimary)) seeded.set(projectId, agentId);

  const cast = resolveCast({
    agents,
    heroes: Object.values(heroes),
    sessions: Object.values(sessions),
    office: { pmMode: office.pmMode, pmSwitchCooldownSec: office.pmSwitchCooldownSec },
    heroesEnabled,
    prevPrimary: seeded,
    now,
    // The Multiverse aggregates every realm into one list here (design section 6.3 splits the cap
    // per realm for the *scene*; the roster approximates with the floor-wide cap for its own count).
    maxCharacters: selected === ALL_FLOORS ? office.multiverseMaxCharacters : office.maxCharacters,
  });
  prevPrimary.current = cast.primary;
  return new Set(cast.hidden);
}

function RosterItem({ agent, selected, onSelect, now, offCanvas }: { agent: Agent; selected: boolean; onSelect: () => void; now: number; offCanvas: boolean }) {
  const lookup = useThemedRoleLookup();
  const role = lookup(agent.role);
  const project = useOfficeStore((s) => s.projects[agent.projectId]?.name);
  const multiFloor = useOfficeStore((s) => s.selectedProjectId === ALL_FLOORS);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cx(
          'w-full rounded-lg border px-2.5 py-2 text-left transition',
          selected ? 'border-cozy/60 bg-ink-700' : 'border-transparent hover:bg-ink-800',
          (agent.status === 'done' || offCanvas) && 'opacity-60',
        )}
      >
        <div className="flex items-center gap-2">
          <Dot color={role.color} />
          <span className="truncate text-xs font-semibold text-ink-100">{role.themedTitle}</span>
          {/* Guild titles read like flavor text ("Archmage"); keep the plain role title (e.g.
              "Architect") visible too, but only when it actually differs (skip the redundant
              duplicate under the modern style, where the two usually match). */}
          {role.themedTitle !== role.title && <span className="truncate text-[10px] text-ink-400">{role.title}</span>}
          {agent.isMain && <Badge>main</Badge>}
          {offCanvas && (
            <span title="Not drawn in the office right now (idle, unbound, or over the character cap)">
              <Badge className="bg-ink-700 text-ink-400">off canvas</Badge>
            </span>
          )}
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
  const hidden = useHiddenAgentIds(agents, now);
  const [showOffCanvas, setShowOffCanvas] = useState(false);
  const shown = showOffCanvas ? agents : agents.filter((a) => !hidden.has(a.id));
  const offCanvasCount = agents.length - agents.filter((a) => !hidden.has(a.id)).length;
  const active = agents.filter((a) => a.status !== 'done').length;
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-ink-700 bg-ink-850">
      <header className="flex items-center justify-between border-b border-ink-700 px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide">Roster</h2>
        <span className="text-[11px] text-ink-400">
          {active} working · {agents.length} total
        </span>
      </header>
      {offCanvasCount > 0 && (
        <div className="flex items-center justify-between border-b border-ink-700 px-3 py-1.5">
          <span className="text-[11px] text-ink-400">{offCanvasCount} off canvas</span>
          <Checkbox checked={showOffCanvas} onChange={setShowOffCanvas} label="Show off-canvas" />
        </div>
      )}
      {shown.length === 0 ? (
        <Empty>{agents.length === 0 ? 'No one is in the office yet.' : 'Everyone here is off canvas — toggle "Show off-canvas" to list them.'}</Empty>
      ) : (
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {shown.map((a) => (
            <RosterItem key={a.id} agent={a} now={now} selected={a.id === selectedId} onSelect={() => onSelect(a.id)} offCanvas={hidden.has(a.id)} />
          ))}
        </ul>
      )}
    </aside>
  );
}
