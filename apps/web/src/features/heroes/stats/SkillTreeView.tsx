import type { KeyboardEvent } from 'react';
import type { SkillAllocation, SkillNode, SkillTree } from '@tagconn/shared';
import { cx } from '../../../components/ui';
import { uiSound } from '../../../lib/audio/uiSound';
import { battleLabel } from '../../battle/labels';
import type { BattleStyle } from '../../../game/battle/types';
import { canAdd, canRemove, nodeStatus, rankIn, type NodeStatus, type PlanCtx, type PlanOp } from './skillPlan';

const BRANCH_ICON = ['⚔️', '🛡️', '⚡'] as const;
const BRANCH_FALLBACK = ['Offense', 'Defense', 'Tempo'] as const;
/** Literal class names so Tailwind can see them. */
const BRANCH_TONE = [
  {
    head: 'text-orange-300',
    ring: 'ring-orange-400/70',
    fill: 'bg-orange-400',
    line: 'bg-orange-400/70',
    glow: 'shadow-[0_0_14px_-2px_rgba(251,146,60,0.55)]',
  },
  {
    head: 'text-sky-300',
    ring: 'ring-sky-400/70',
    fill: 'bg-sky-400',
    line: 'bg-sky-400/70',
    glow: 'shadow-[0_0_14px_-2px_rgba(56,189,248,0.55)]',
  },
  {
    head: 'text-emerald-300',
    ring: 'ring-emerald-400/70',
    fill: 'bg-emerald-400',
    line: 'bg-emerald-400/70',
    glow: 'shadow-[0_0_14px_-2px_rgba(52,211,153,0.55)]',
  },
] as const;
const STAT_NAME = { hp: 'HP', atk: 'ATK', def: 'DEF', spd: 'SPD' } as const;

/** Title and per-rank text of a node's effect. Moves use the themed move name. */
export function describeNode(node: SkillNode, style: BattleStyle): { title: string; detail: string; isMove: boolean } {
  const e = node.effect;
  switch (e.kind) {
    case 'move':
      return {
        title: battleLabel(style, 'move', e.moveId),
        detail: 'Unlocks a new move for battles',
        isMove: true,
      };
    case 'stat':
      return {
        title: `${STAT_NAME[e.stat]} boost`,
        detail: `+${e.pctPerRank}% ${STAT_NAME[e.stat]} per rank`,
        isMove: false,
      };
    case 'crit':
      return {
        title: 'Critical eye',
        detail: `+${e.pctPerRank}% critical hit chance per rank`,
        isMove: false,
      };
    case 'focusRegen':
      return {
        title: 'Second wind',
        detail: `+${e.perRank} FOCUS regained each turn per rank`,
        isMove: false,
      };
    case 'statusResist':
      return {
        title: 'Thick skin',
        detail: `+${e.pctPerRank}% status resistance per rank`,
        isMove: false,
      };
    case 'healBoost':
      return {
        title: 'Soothing touch',
        detail: `+${e.pctPerRank}% healing per rank`,
        isMove: false,
      };
    case 'typeBoost':
      return {
        title: 'Specialist',
        detail: `+${e.pctPerRank}% damage with type moves per rank`,
        isMove: false,
      };
  }
}

function Pips({ rank, max, fill }: { rank: number; max: number; fill: string }) {
  return (
    <span className="flex gap-0.5" aria-hidden="true">
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={cx('size-1.5 rounded-full transition-colors motion-reduce:transition-none', i < rank ? fill : 'bg-ink-700')} />
      ))}
    </span>
  );
}

interface NodeProps {
  node: SkillNode;
  status: NodeStatus;
  style: BattleStyle;
  readOnly: boolean;
  onAdd(): void;
  onRemove(): void;
}

function Node({ node, status, style, readOnly, onAdd, onRemove }: NodeProps) {
  const tone = BRANCH_TONE[node.branch]!;
  const { title, detail, isMove } = describeNode(node, style);
  const { state, rank } = status;
  const canPlus = !readOnly && status.addBlock === null;
  const canMinus = !readOnly && rank > 0 && status.removeBlock === null;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === '+' || e.key === '=' || e.key === 'ArrowUp' || e.key === 'Enter') {
      e.preventDefault();
      onAdd();
    } else if (e.key === '-' || e.key === '_' || e.key === 'ArrowDown' || e.key === 'Backspace') {
      e.preventDefault();
      onRemove();
    }
  };
  const stateText = state === 'maxed' ? 'maxed' : state === 'owned' ? 'learned' : state === 'locked' ? 'locked' : 'available';
  const blocker = status.addBlock && rank < node.maxRank ? status.addBlock : null;
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={`${title}, tier ${node.tier}, rank ${rank} of ${node.maxRank}, ${stateText}${blocker ? `: ${blocker}` : ''}. Press plus to learn, minus to unlearn.`}
      data-state={state}
      data-skill={node.id}
      onKeyDown={onKeyDown}
      title={`${title}: ${detail}\nTier ${node.tier}, needs level ${node.minLevel}${blocker ? `\n${blocker}` : ''}`}
      className={cx(
        'relative w-full rounded-lg border px-2.5 py-2 outline-none transition-[box-shadow,background-color,border-color,opacity] focus-visible:ring-2 focus-visible:ring-cozy motion-reduce:transition-none',
        state === 'locked' && 'border-ink-800 bg-ink-900/60 opacity-60',
        state === 'available' && 'border-ink-600 bg-ink-800',
        (state === 'owned' || state === 'maxed') && cx('border-transparent bg-ink-800 ring-2', tone.ring, tone.glow),
      )}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden="true" className={cx('mt-0.5 grid size-7 shrink-0 place-items-center rounded-md text-sm', state === 'locked' ? 'bg-ink-850 grayscale' : 'bg-ink-700')}>
          {state === 'locked' ? '🔒' : isMove ? '✨' : BRANCH_ICON[node.branch]}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cx('truncate text-xs font-semibold', state === 'locked' ? 'text-ink-400' : 'text-ink-100')}>{title}</p>
          <p className="text-[10px] leading-snug text-ink-400">{detail}</p>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Pips rank={rank} max={node.maxRank} fill={tone.fill} />
          <span className="font-mono text-[10px] text-ink-300">
            {rank}/{node.maxRank}
          </span>
          {state === 'maxed' && <span className="rounded bg-ink-700 px-1 text-[9px] font-semibold uppercase tracking-wide text-cozy">max</span>}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-ink-400">Lv {node.minLevel}</span>
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Unlearn a rank of ${title}`}
            disabled={!canMinus}
            onClick={onRemove}
            className="grid size-5 place-items-center rounded bg-ink-700 text-xs leading-none text-ink-100 hover:bg-ink-600 disabled:cursor-not-allowed disabled:opacity-30"
          >
            −
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Learn a rank of ${title}`}
            disabled={!canPlus}
            onClick={onAdd}
            className="grid size-5 place-items-center rounded bg-cozy text-xs font-bold leading-none text-ink-950 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
          >
            +
          </button>
        </div>
      </div>
      {blocker && state !== 'maxed' && (
        <p className="mt-1 text-[10px] text-ink-400" data-testid="skill-reason">
          {state === 'locked' ? '🔒 ' : ''}
          {blocker}
        </p>
      )}
    </div>
  );
}

export interface SkillTreeViewProps {
  tree: SkillTree;
  plan: SkillAllocation;
  ctx: PlanCtx;
  style: BattleStyle;
  /** True when the user cannot write: every control is inert. */
  readOnly: boolean;
  onOp(op: PlanOp): void;
}

/** Three branches by four tiers; tier 1 at the top, with a line through every satisfied prerequisite. */
export function SkillTreeView({ tree, plan, ctx, style, readOnly, onOp }: SkillTreeViewProps) {
  const label = (n: SkillNode) => describeNode(n, style).title;
  const attempt = (op: { type: 'add' | 'remove'; id: string }) => {
    if (readOnly) return uiSound('ui-error');
    const ok = (op.type === 'add' ? canAdd(plan, op.id, ctx) : canRemove(plan, op.id, ctx)).ok;
    uiSound(ok ? (op.type === 'add' ? 'ui-confirm' : 'ui-back') : 'ui-error');
    if (ok) onOp(op);
  };
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" role="group" aria-label="Skill tree">
      {([0, 1, 2] as const).map((branch) => {
        const nodes = tree.nodes.filter((n) => n.branch === branch).sort((a, b) => a.tier - b.tier);
        const tone = BRANCH_TONE[branch];
        const name = battleLabel(style, 'branch', `${tree.classId}.${branch}`);
        const branchName = /\d/.test(name) ? BRANCH_FALLBACK[branch] : name;
        return (
          <section key={branch} aria-label={branchName} className="min-w-0">
            <h4 className={cx('mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider', tone.head)}>
              <span aria-hidden="true">{BRANCH_ICON[branch]}</span>
              {branchName}
            </h4>
            <ol className="m-0 flex list-none flex-col items-stretch p-0">
              {nodes.map((n, i) => {
                const status = nodeStatus(plan, n, ctx, label);
                const prev = nodes[i - 1];
                const linked = !!prev && rankIn(plan, prev.id) >= 1;
                return (
                  <li key={n.id} className="flex flex-col items-center">
                    {prev && <span aria-hidden="true" className={cx('h-3 w-0.5 rounded-full transition-colors motion-reduce:transition-none', linked ? tone.line : 'bg-ink-700')} />}
                    <Node node={n} status={status} style={style} readOnly={readOnly} onAdd={() => attempt({ type: 'add', id: n.id })} onRemove={() => attempt({ type: 'remove', id: n.id })} />
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
