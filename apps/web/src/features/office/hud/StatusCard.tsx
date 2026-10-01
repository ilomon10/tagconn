import type { Agent } from '@tagconn/shared';
import { useNow, useThemedRoleLookup } from '../../../lib/hooks';
import { elapsed, formatTokens } from '../../../lib/format';
import { contextRatio, contextWindowFor, totalTokens } from '../../../lib/tokens';
import { isAgentOnARoll, strainFor } from '../../../game/drama';
import { ALL_FLOORS, useOfficeStore } from '../../../stores/officeStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { Badge, Button, Checkbox, cx } from '../../../components/ui';
import { hudLabels, strainSentence, xpLevel } from './hudMath';
import { Portrait } from './Portrait';
import { StrainIcon } from './StrainIcon';
import { STATUS_STYLE, statusLabel } from './status';
import { usePortraitLook } from './usePortraitLook';

interface StatusCardProps {
  /** The selected agent, or undefined when it has left the office (the card then says so). */
  agent: Agent | undefined;
  /** Phones: one compact row. */
  compact: boolean;
  follow: boolean;
  onFollowChange: (follow: boolean) => void;
  onDetails: () => void;
  onClose: () => void;
}

const closeButton = (onClose: () => void) => (
  <Button variant="ghost" onClick={onClose} aria-label="Deselect character" title="Deselect (Esc)" className="shrink-0">
    ✕
  </Button>
);

/** Thin game-style bar: `role="meter"` so a screen reader gets the value, not just the fill. */
function Meter({ label, value, text, fill }: { label: string; value: number; text: string; fill: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[10px] font-medium text-ink-300">{label}</span>
      <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={text} className="h-2 min-w-8 flex-1 overflow-hidden rounded-full bg-ink-950/70 ring-1 ring-inset ring-ink-600/60">
        <div className={cx('h-full rounded-full transition-[width] duration-300 ease-out', fill)} style={{ width: `${pct}%` }} />
      </div>
      <span className="shrink-0 font-pixel text-[10px] text-ink-300">{text}</span>
    </div>
  );
}

/**
 * The selected character, RPG-status style (docs/design/game-office.md section 3.1), top-left over the
 * canvas: portrait, name and themed title, what it is doing, the context bar as mana, tokens as XP and
 * level, how it is coping (strain), and the Details / Follow / close controls.
 */
export function StatusCard({ agent, compact, follow, onFollowChange, onDetails, onClose }: StatusCardProps) {
  if (!agent) {
    return (
      <div data-camera-overlay="top" className="anim-fade pointer-events-auto absolute left-3 top-3 z-10 flex items-center gap-3 rounded-xl border border-ink-600/70 bg-ink-850/90 py-2 pl-3 pr-1.5 shadow-lg backdrop-blur">
        <p className="text-xs text-ink-300">This agent has left the office.</p>
        {closeButton(onClose)}
      </div>
    );
  }
  return <Card agent={agent} compact={compact} follow={follow} onFollowChange={onFollowChange} onDetails={onDetails} onClose={onClose} />;
}

function Card({ agent, compact, follow, onFollowChange, onDetails, onClose }: StatusCardProps & { agent: Agent }) {
  const now = useNow();
  const { look, hero } = usePortraitLook(agent);
  const role = useThemedRoleLookup()(agent.role, { projectId: agent.projectId, hero });
  const drama = useSettingsStore((s) => s.settings.office.drama);
  const atMultiverse = useOfficeStore((s) => s.selectedProjectId === ALL_FLOORS);
  const labels = hudLabels(atMultiverse ? 'rift' : look.style);
  const name = hero ? hero.name : role.themedTitle;
  const usage = agent.usage;
  const ratio = contextRatio(usage);
  const manaText = usage ? `${formatTokens(usage.contextTokens)} / ${formatTokens(contextWindowFor(usage.model))}` : 'no data';
  const tokens = usage ? totalTokens(usage) : 0;
  const strain = strainFor(agent, now, drama, isAgentOnARoll(agent.id, now, drama));
  const quest = elapsed(agent.startedAt, agent.endedAt ?? now);

  if (compact) {
    return (
      <div data-camera-overlay="top" className="anim-fade pointer-events-auto absolute left-3 top-3 z-10 flex w-[min(26rem,calc(100%-1.5rem))] items-center gap-2 rounded-xl border border-ink-600/70 bg-ink-850/90 p-1.5 shadow-lg backdrop-blur">
        <div className="shrink-0 rounded-lg bg-ink-900" style={{ boxShadow: `0 0 0 2px ${role.color}` }}>
          <Portrait look={look} scale={2} className="rounded-lg" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-ink-100">{name}</span>
            {strain && <StrainIcon kind={strain} scale={1} />}
            <Badge className={cx('shrink-0', STATUS_STYLE[agent.status])}>{statusLabel(agent)}</Badge>
          </div>
          <Meter label={labels.mana} value={ratio} text={manaText} fill="bg-sky-400/90" />
        </div>
        <Button variant="subtle" onClick={onDetails}>
          Details
        </Button>
        {closeButton(onClose)}
      </div>
    );
  }

  return (
    <section
      aria-label={`${name}, status`}
      data-camera-overlay="top"
      className="anim-fade pointer-events-auto absolute left-3 top-3 z-10 w-72 space-y-2.5 rounded-xl border border-ink-600/70 bg-ink-850/90 p-3 shadow-lg backdrop-blur"
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-lg bg-ink-900" style={{ boxShadow: `0 0 0 2px ${role.color}, 0 0 16px -4px ${role.color}99` }}>
          <Portrait look={look} scale={4} className="rounded-lg" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-start gap-1">
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold leading-5 text-ink-100">{name}</h2>
            {closeButton(onClose)}
          </div>
          {/* Guild titles read like flavor text ("Archmage"); keep the plain role title visible too, but only when it differs. */}
          <p className="truncate text-[11px] text-ink-300">
            {hero ? role.themedTitle : role.themedTitle !== role.title ? role.title : agent.description}
            {hero && role.themedTitle !== role.title ? ` · ${role.title}` : ''}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            <Badge className={STATUS_STYLE[agent.status]}>{statusLabel(agent)}</Badge>
            {agent.isMain && <Badge>main</Badge>}
          </div>
        </div>
      </div>
      <div className="space-y-1.5">
        <Meter label={labels.mana} value={ratio} text={manaText} fill="bg-sky-400/90" />
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[10px] font-medium text-ink-300">{labels.xp}</span>
          <span className="font-pixel text-[10px] text-ink-100">{formatTokens(tokens)}</span>
          <span className="ml-auto rounded bg-cozy/90 px-1.5 py-0.5 font-pixel text-[10px] font-bold leading-none text-ink-950">Lv {xpLevel(tokens)}</span>
        </div>
      </div>
      <dl className="grid grid-cols-[3rem_1fr] gap-x-2 gap-y-0.5 text-[11px]">
        <dt className="text-ink-300">Tool</dt>
        <dd className="truncate text-ink-100">{agent.currentTool ? `${agent.currentTool}${agent.toolStartedAt ? ` · ${elapsed(agent.toolStartedAt, now)}` : ''}` : 'none'}</dd>
        <dt className="text-ink-300">Quest</dt>
        <dd className="text-ink-100">{quest}</dd>
      </dl>
      {strain && (
        <p className="flex items-center gap-1.5 rounded-md bg-ink-950/50 px-2 py-1 text-[11px] text-ink-100">
          <StrainIcon kind={strain} scale={2} />
          {strainSentence(strain, agent, now)}
        </p>
      )}
      <div className="flex items-center gap-2 pt-0.5">
        <Button variant="subtle" onClick={onDetails}>
          Details
        </Button>
        <span className="ml-auto">
          <Checkbox checked={follow} onChange={onFollowChange} label="Follow" />
        </span>
      </div>
    </section>
  );
}
