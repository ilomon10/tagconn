import { memo } from 'react';
import type { Agent } from '@tagconn/shared';
import { useThemedRoleLookup } from '../../../lib/hooks';
import type { StrainKind } from '../../../game/themes/types';
import { cx } from '../../../components/ui';
import { Portrait } from './Portrait';
import { StrainIcon } from './StrainIcon';
import { STATUS_DOT, statusLabel } from './status';
import { usePortraitLook } from './usePortraitLook';

/** One party member (memoized: the bar ticks every second, a chip only re-renders when its own props change): a bust in a role-colour ring, with a status dot, the strain emote and a `main` pip.
 *  Raised when selected, dimmed when done or off canvas. */
export const PortraitChip = memo(function PortraitChip({ agent, selected, offCanvas, strain, onSelect }: { agent: Agent; selected: boolean; offCanvas: boolean; strain: StrainKind | null; onSelect: (id: string) => void }) {
  const { look, hero } = usePortraitLook(agent);
  const role = useThemedRoleLookup()(agent.role, { projectId: agent.projectId, hero });
  const name = hero ? hero.name : role.themedTitle;
  const label = `${name}, ${hero ? `${role.themedTitle}, ` : ''}${statusLabel(agent)}${offCanvas ? ', off canvas' : ''}`;
  return (
    <button
      type="button"
      onClick={() => onSelect(agent.id)}
      aria-label={label}
      aria-pressed={selected}
      title={`${name} · ${statusLabel(agent)}`}
      data-agent-chip={agent.id}
      className={cx(
        'relative grid size-12 shrink-0 place-items-center rounded-xl bg-ink-900 outline-offset-2 transition-[transform,opacity,box-shadow,background-color] duration-150 ease-out active:scale-[0.96] coarse:size-14',
        selected ? '-translate-y-1 bg-ink-700' : 'hover:-translate-y-0.5 hover:bg-ink-800',
        (agent.status === 'done' || offCanvas) && !selected && 'opacity-55',
      )}
      style={{ boxShadow: selected ? `0 0 0 2px ${role.color}, 0 6px 14px -4px ${role.color}88` : `0 0 0 2px ${role.color}66` }}
    >
      <Portrait look={look} scale={2} className="rounded-lg" />
      <span aria-hidden="true" className={cx('absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-ink-850', STATUS_DOT[agent.status], agent.status === 'waiting' && 'motion-safe:animate-pulse')} />
      {agent.isMain && <span aria-hidden="true" className="absolute -left-1 -top-1 rounded bg-cozy px-1 text-[8px] font-bold leading-3 text-ink-950">M</span>}
      {strain && (
        <span aria-hidden="true" className="absolute -right-1.5 -top-2 drop-shadow">
          <StrainIcon kind={strain} scale={2} />
        </span>
      )}
    </button>
  );
});
