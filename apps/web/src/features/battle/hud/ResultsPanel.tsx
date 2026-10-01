import { useEffect, useRef, useState } from 'react';
import type { BattleOutcome, BattleResult, BattleSetup, HeroAward, HeroProgress } from '@tagconn/shared';
import { useProgressStore } from '../../../stores/progressStore';
import { Button, cx } from '../../../components/ui';
import { sfxBus, type SfxId } from '../../../game/sfxBus';
import type { BattleStyle } from '../../../game/battle/types';
import { battleLabel } from '../labels';

/** When each reveal stage starts (ms after mount); reduced motion shows everything at once. */
export const RESULT_STAGE_MS = { xp: 450, levelUp: 1300, loot: 2000 } as const;
export const XP_FILL_MS = 700;
const XP_TICK_MS = 120;

export function resultHeadline(result: BattleResult, enemyName: string): string {
  switch (result) {
    case 'won': return 'Victory!';
    case 'lost': return 'Defeated…';
    case 'fled': return 'Got away safely';
    case 'timeout': return `${enemyName} lost interest`;
  }
}

/** The sting for the headline, if any (fleeing and timeouts are quiet). */
export function resultSting(result: BattleResult): SfxId | null {
  return result === 'won' ? 'battle-victory' : result === 'lost' ? 'battle-defeat' : null;
}

/** Pure: the KO line for a hero ("resting N min", or "keeps working" when a live agent keeps the hero busy). */
export function koNote(a: Pick<HeroAward, 'fainted' | 'koUntil'>, resolvedAt: number): string | null {
  if (!a.fainted) return null;
  if (a.koUntil === null) return '🩹 keeps working';
  const min = Math.max(1, Math.ceil((a.koUntil - resolvedAt) / 60_000));
  return `💫 resting ${min} min`;
}

/** Pure: which optional stages exist for an outcome. */
export function resultStages(o: Pick<BattleOutcome, 'heroes' | 'loot'>): { xp: boolean; levelUp: boolean; loot: boolean } {
  return { xp: o.heroes.some((h) => h.xpGained > 0), levelUp: o.heroes.some((h) => h.levelAfter > h.levelBefore), loot: o.loot !== null };
}

export type XpBarPlan = { kind: 'gain' } | { kind: 'progress'; from: number; to: number; wrapped: boolean; maxed: boolean };

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Pure: how a hero's XP bar fills. `progress` is the hero's registry entry; it counts as post-award when it was updated
 * at or after `resolvedAt`, otherwise (the socket update is still in flight) the award is added to it. Falls back to the
 * plain gain meter when the progress is unknown or cannot be placed. A level-up fills to 100 %, wraps, then fills the new
 * level (the previous level's start is not known here, so the first leg starts empty).
 */
export function xpBarPlan(a: Pick<HeroAward, 'xpGained' | 'levelBefore' | 'levelAfter'>, p: HeroProgress | undefined, resolvedAt: number): XpBarPlan {
  if (!p) return { kind: 'gain' };
  const levelUp = a.levelAfter > a.levelBefore;
  const post = p.updatedAt >= resolvedAt;
  let endXp: number;
  if (post) {
    if (p.level !== a.levelAfter) return { kind: 'gain' };
    endXp = p.xp;
  } else {
    if (levelUp || p.level !== a.levelBefore) return { kind: 'gain' };
    endXp = p.xp + a.xpGained;
    if (p.nextLevelXp !== null && endXp >= p.nextLevelXp) return { kind: 'gain' };
  }
  const maxed = p.nextLevelXp === null;
  const frac = (xp: number): number => (maxed ? 1 : p.nextLevelXp! > p.levelXp ? clamp01((xp - p.levelXp) / (p.nextLevelXp! - p.levelXp)) : 0);
  const to = frac(endXp);
  return { kind: 'progress', from: levelUp ? 0 : frac(endXp - a.xpGained), to, wrapped: levelUp, maxed };
}

/** The XP meter: real level progress when known (with a wrap on level-up), else a 0 to 100 % gain meter. */
function XpBar({ name, gained, plan, stage, reduced }: { name: string; gained: number; plan: XpBarPlan; stage: number; reduced: boolean }) {
  const progress = plan.kind === 'progress' ? plan : null;
  // After the wrap the bar snaps to empty (no transition), then fills the new level.
  const [wrapStep, setWrapStep] = useState(0);
  useEffect(() => {
    if (!progress?.wrapped || stage < 2 || reduced) return;
    setWrapStep(1);
    const t = setTimeout(() => setWrapStep(2), 40);
    return () => clearTimeout(t);
  }, [stage >= 2]);
  let scale: number;
  let ms = XP_FILL_MS;
  if (!progress) scale = stage >= 1 && gained > 0 ? 1 : 0;
  else if (reduced) scale = progress.to;
  else if (progress.wrapped) {
    if (stage < 1) scale = progress.from;
    else if (wrapStep === 0) { scale = 1; ms = XP_FILL_MS * 0.6; }
    else if (wrapStep === 1) { scale = 0; ms = 0; }
    else scale = progress.to;
  } else scale = stage >= 1 ? progress.to : progress.from;
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div
        role="progressbar"
        aria-label={`${name} experience${progress ? '' : ' gained'}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress ? Math.round(progress.to * 100) : gained > 0 ? 100 : 0}
        aria-valuetext={progress ? `${gained} XP gained, ${progress.maxed ? 'max level' : `${Math.round(progress.to * 100)}% to the next level`}` : `${gained} XP`}
        className="h-2 flex-1 overflow-hidden rounded-sm bg-ink-950 ring-1 ring-ink-600"
      >
        <div
          className="h-full w-full origin-left bg-violet-400 motion-safe:transition-transform motion-safe:ease-linear"
          style={{ transform: `scaleX(${scale})`, transitionDuration: `${ms}ms` }}
        />
      </div>
      <span className="w-14 shrink-0 text-right font-pixel text-[10px] tabular-nums text-violet-200">+{gained} XP{progress?.maxed ? ' MAX' : ''}</span>
    </div>
  );
}

/** 0 headline, 1 xp, 2 level-ups, 3 loot. */
function useStage(stages: ReturnType<typeof resultStages>, reduced: boolean): number {
  const [stage, setStage] = useState(reduced ? 3 : 0);
  useEffect(() => {
    const sting = (id: SfxId) => sfxBus.emit({ id });
    if (reduced) {
      if (stages.xp) sting('battle-xp-tick');
      if (stages.levelUp) sting('battle-level-up');
      if (stages.loot) sting('battle-loot');
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    at(RESULT_STAGE_MS.xp, () => {
      setStage(1);
      if (!stages.xp) return;
      let n = 0;
      const iv = setInterval(() => {
        sting('battle-xp-tick');
        if (++n >= Math.floor(XP_FILL_MS / XP_TICK_MS)) clearInterval(iv);
      }, XP_TICK_MS);
      timers.push(iv as unknown as ReturnType<typeof setTimeout>);
    });
    at(RESULT_STAGE_MS.levelUp, () => {
      setStage(2);
      if (stages.levelUp) sting('battle-level-up');
    });
    at(RESULT_STAGE_MS.loot, () => {
      setStage(3);
      if (stages.loot) sting('battle-loot');
    });
    return () => timers.forEach((t) => (clearTimeout(t), clearInterval(t)));
  }, []);
  return stage;
}

const reveal = (on: boolean) => cx('motion-safe:transition-[opacity,transform] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.23,1,0.32,1)]', on ? 'opacity-100' : 'opacity-0 motion-safe:translate-y-2');

export interface ResultsPanelProps {
  setup: BattleSetup;
  style: BattleStyle;
  /** The engine's result (known while resolving). */
  result: BattleResult;
  phase: 'resolving' | 'results' | 'error';
  outcome: BattleOutcome | null;
  error?: string | null;
  reduced: boolean;
  onContinue: () => void;
  onOpenHero?: (heroId: string) => void;
  /** Hero progress by hero id for real XP bars; defaults to the live progress store. */
  progressByHero?: Record<string, HeroProgress>;
}

/** Centered JRPG results card: headline, per-hero XP / level-up / KO, loot, Continue. */
export function ResultsPanel(props: ResultsPanelProps) {
  const { setup, style, result, phase, outcome, error, reduced, onContinue, onOpenHero } = props;
  const enemyName = battleLabel(style, 'enemy', setup.enemy.ref.kind === 'enemy' ? setup.enemy.ref.npcKind : 'enemy');
  const tone = result === 'won' ? 'border-cozy text-cozy' : result === 'lost' ? 'border-rose-300/80 text-rose-200' : 'border-sky-300/80 text-sky-200';
  return (
    <section
      aria-label="Battle results"
      className={cx('pointer-events-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg bg-ink-950/95 p-[3px] shadow-[0_0_28px_-6px_rgba(245,192,122,0.55)] backdrop-blur', reveal(true))}
    >
      <div className={cx('rounded-md border-2 bg-ink-900/95 p-4 ring-1 ring-inset ring-ink-600/70', phase === 'error' ? 'border-rose-300/80' : tone.split(' ')[0])}>
        {phase === 'error' ? (
          <ErrorBody message={error ?? 'Something went wrong.'} onContinue={onContinue} />
        ) : phase === 'resolving' || !outcome ? (
          <>
            <h2 className={cx('text-center font-pixel text-lg', tone.split(' ')[1])}>{resultHeadline(result, enemyName)}</h2>
            <p role="status" className="mt-3 flex items-center justify-center gap-2 text-xs text-ink-300">
              <span aria-hidden="true" className="size-3 rounded-full border-2 border-ink-500 border-t-cozy motion-safe:animate-spin" />
              Recording the battle…
            </p>
          </>
        ) : (
          <Revealed {...props} outcome={outcome} enemyName={enemyName} tone={tone.split(' ')[1]!} onOpenHero={onOpenHero} />
        )}
      </div>
    </section>
  );
}

function ErrorBody({ message, onContinue }: { message: string; onContinue: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.querySelector('button')?.focus(), []);
  return (
    <>
      <h2 className="text-center font-pixel text-lg text-rose-200">The battle was interrupted</h2>
      <p role="alert" className="mt-2 break-words text-center text-xs text-ink-300">{message}</p>
      <div ref={ref} className="mt-4 flex justify-center">
        <Button variant="subtle" data-sfx="ui-close" onClick={onContinue}>Close</Button>
      </div>
    </>
  );
}

function Revealed({ setup, style, result, outcome, reduced, onContinue, onOpenHero, progressByHero, enemyName, tone }: ResultsPanelProps & { outcome: BattleOutcome; enemyName: string; tone: string }) {
  const storeProgress = useProgressStore((s) => s.progress);
  const progressMap = progressByHero ?? storeProgress;
  const stages = resultStages(outcome);
  const stage = useStage(stages, reduced);
  const stingId = resultSting(result);
  const btn = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (stingId) sfxBus.emit({ id: stingId });
    btn.current?.querySelector('button')?.focus();
  }, []);
  const name = (a: HeroAward) => setup.party[a.memberIndex]?.name ?? 'Hero';
  const lootHero = outcome.loot ? outcome.heroes.find((h) => h.heroId === outcome.loot!.heroId) : undefined;
  return (
    <>
      <h2 className={cx('text-center font-pixel text-xl', tone)}>{resultHeadline(result, enemyName)}</h2>
      <p className="mt-0.5 text-center text-[10px] text-ink-400">{outcome.turns} turn{outcome.turns === 1 ? '' : 's'}</p>
      <ul className="mt-3 space-y-2.5" aria-label="Heroes">
        {outcome.heroes.map((a) => {
          const up = a.levelAfter > a.levelBefore;
          const ko = koNote(a, outcome.resolvedAt);
          return (
            <li key={`${a.heroId}-${a.memberIndex}`} className="rounded-md bg-ink-950/70 p-2 ring-1 ring-ink-700">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-semibold text-ink-100">{name(a)}</span>
                <span className="shrink-0 font-pixel text-[10px] text-ink-300">Lv {up && stage >= 2 ? a.levelAfter : a.levelBefore}</span>
              </div>
              <XpBar name={name(a)} gained={a.xpGained} plan={xpBarPlan(a, Object.hasOwn(progressMap, a.heroId) ? progressMap[a.heroId] : undefined, outcome.resolvedAt)} stage={stage} reduced={reduced} />
              {up && (
                <p className={cx('mt-1.5 rounded bg-cozy/15 px-2 py-1 text-center text-xs font-semibold text-cozy', reveal(stage >= 2))} aria-hidden={stage < 2}>
                  Level up! {a.levelBefore} → {a.levelAfter}
                  {a.skillPointsGained > 0 && <span className="ml-2 font-normal text-ink-200">+{a.skillPointsGained} skill point{a.skillPointsGained === 1 ? '' : 's'}</span>}
                </p>
              )}
              {ko && <p className="mt-1.5 text-[11px] text-ink-300">{ko}</p>}
              {onOpenHero && (
                <button type="button" onClick={() => onOpenHero(a.heroId)} className="mt-1 text-[11px] text-sky-300 underline-offset-2 hover:underline focus-visible:underline">
                  Open hero sheet
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {outcome.loot && (
        <p className={cx('mt-3 rounded-md border border-cozy/50 bg-cozy/10 px-3 py-2 text-center text-xs text-ink-50', reveal(stage >= 3))} aria-hidden={stage < 3}>
          🎁 {battleLabel(style, 'loot', outcome.loot.lootId)}{lootHero ? ` for ${name(lootHero)}` : ''}
        </p>
      )}
      <div ref={btn} className="mt-4 flex justify-center">
        <Button variant="primary" data-sfx="ui-confirm" onClick={onContinue}>Continue</Button>
      </div>
    </>
  );
}
