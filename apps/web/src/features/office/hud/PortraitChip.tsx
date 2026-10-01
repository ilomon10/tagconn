import { memo } from 'react';
import type { Agent } from '@tagconn/shared';
import { useThemedRoleLookup } from '../../../lib/hooks';
import type { StrainKind } from '../../../game/themes/types';
import { cx } from '../../../components/ui';
import { Portrait } from './Portrait';
import { StrainIcon } from './StrainIcon';
import { STATUS_DOT, statusLabel } from './status';
import { usePortraitLook } from './usePortraitLook';
import { useAgentLevel, useHeroProgress, useNow } from '../../battle/useProgress';

/** One party member (memoized: the bar ticks every second, a chip only re-renders when its own props change): a bust in a role-colour ring, with a status dot, the strain emote and a `main` pip.
 *  Raised when selected, dimmed when done or off canvas. */
export const PortraitChip = memo(function PortraitChip({ agent, selected, offCanvas, strain, onSelect }: { agent: Agent; selected: boolean; offCanvas: boolean; strain: StrainKind | null; onSelect: (id: string) => void }) {
  const { look, hero } = usePortraitLook(agent);
  const role = useThemedRoleLookup()(agent.role, { projectId: agent.projectId, hero });
  const name = hero ? hero.name : role.themedTitle;
  const lv = useAgentLevel(agent, hero);
  const progress = useHeroProgress(hero?.id);
  const now = useNow(progress?.koUntil);
  const ko = !!progress && progress.koUntil !== null && progress.koUntil > now;
  const working = agent.status === 'active' && agent.activity !== 'idle';
  const label = `${name}, ${hero ? `${role.themedTitle}, ` : ''}${statusLabel(agent)}${offCanvas ? ', off canvas' : ''}${lv ? `, level ${lv.level}${lv.temporary ? ' (temporary)' : ''}` : ''}${ko ? ', knocked out' : ''}`;
  return (
    <button
      type="button"
      onClick={() => onSelect(agent.id)}
      aria-label={label}
      aria-pressed={selected}
      title={`${name} · ${statusLabel(agent)}`}
      data-agent-chip={agent.id}
      data-sfx="none"
      data-sfx-hover
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
      {lv && (
        <span
          aria-hidden="true"
          data-level-badge
          className={cx('absolute -bottom-1 -left-1 min-w-4 rounded-full px-1 text-center text-[9px] font-bold leading-4 text-ink-950', lv.temporary && 'opacity-70')}
          style={{ backgroundColor: role.color }}
        >
          {lv.temporary ? '~' : ''}{lv.level}
        </span>
      )}
      {ko && (
        <span aria-hidden="true" data-ko-icon className="absolute -bottom-1.5 left-3.5 text-[10px] leading-none drop-shadow">
          {working ? '🩹' : '💫'}
        </span>
      )}
      {strain && (
        <span aria-hidden="true" className="absolute -right-1.5 -top-2 drop-shadow">
          <StrainIcon kind={strain} scale={2} />
        </span>
      )}
    </button>
  );
});
