import { useEffect, useMemo, useRef, useState } from 'react';
import { CLASS_TYPE, SKILL_TREES, isKnockedOut, skillPointsTotal, statsFor, type Hero } from '@tagconn/shared';
import { Button, cx } from '../../../components/ui';
import { uiSound } from '../../../lib/audio/uiSound';
import { PAIR_TO_CHANGE_MESSAGE } from '../../../lib/auth';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useRequireAdmin } from '../../auth/useRequireAdmin';
import { battleLabel } from '../../battle/labels';
import { healHero, saveSkills } from '../../battle/commands';
import { useHeroProgress, useNow } from '../../battle/useProgress';
import type { BattleStyle } from '../../../game/battle/types';
import { StatsTable } from './StatsTable';
import { SkillTreeView } from './SkillTreeView';
import { apply, canRespec, checkPlan, classifySaveError, describeCheck, planFrom, pointsLeft, pointsSpent, sameAllocation, type PlanCtx } from './skillPlan';

const fmt = (n: number): string => Math.round(n).toLocaleString();

/** The `Stats & Skills` section of the hero editor (docs/design/battles.md 3.8): level, XP, stats, record, and the skill tree. */
export function HeroStatsSheet({ hero }: { hero: Hero }) {
  const progress = useHeroProgress(hero.id);
  const settings = useSettingsStore((s) => s.settings);
  const { allowed, guard } = useRequireAdmin();
  const now = useNow(progress?.koUntil);
  const style: BattleStyle = settings.office.style;
  const cfg = settings.progression;

  const [plan, setPlan] = useState<Readonly<Record<string, number>>>(() => planFrom({ skills: progress?.skills ?? {} }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  // Adopt remote changes (a battle's bonus point, a role change refund) unless the user has unsaved edits.
  const prevSaved = useRef(progress?.skills ?? {});
  const skillsKey = progress ? JSON.stringify(progress.skills) : '';
  useEffect(() => {
    if (!progress) return;
    if (sameAllocation(plan, prevSaved.current)) setPlan(planFrom(progress));
    prevSaved.current = progress.skills;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillsKey, progress?.classId]);

  // A different hero starts from its own stored plan.
  useEffect(() => {
    setPlan(planFrom({ skills: progress?.skills ?? {} }));
    setError(null);
    setConflict(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hero.id]);

  const view = useMemo(() => {
    if (!progress) return null;
    const tree = SKILL_TREES[progress.classId];
    const totalPoints = skillPointsTotal(progress.level, cfg.skillPointsPerLevel, progress.bonusPoints);
    const ctx: PlanCtx = {
      tree,
      saved: progress.skills,
      level: progress.level,
      totalPoints,
      allowRespec: cfg.allowRespec,
    };
    return {
      tree,
      ctx,
      current: statsFor(progress.classId, progress.level, progress.skills),
      planned: statsFor(progress.classId, progress.level, plan),
    };
  }, [progress, cfg.skillPointsPerLevel, cfg.allowRespec, plan]);

  if (!cfg.enabled) return <p className="mt-4 text-xs text-ink-400">Levels and battles are switched off (Settings, Progression).</p>;
  if (!progress || !view) return <p className="mt-4 text-xs text-ink-400">This hero has no progress yet. It earns XP from the tokens its agent spends.</p>;

  const { ctx, tree } = view;
  const left = pointsLeft(plan, ctx.totalPoints);
  const dirty = !sameAllocation(plan, progress.skills);
  const check = checkPlan(plan, ctx);
  const checkText = describeCheck(check, tree);
  const knockedOut = isKnockedOut(progress, now);
  const span = progress.nextLevelXp === null ? null : Math.max(1, progress.nextLevelXp - progress.levelXp);
  const into = Math.max(0, progress.xp - progress.levelXp);
  const pct = span === null ? 100 : Math.min(100, (into / span) * 100);
  const readOnly = !allowed || busy;
  const respecOk = canRespec(ctx);

  const doSave = async (force: boolean) => {
    if (busy || !dirty || !check.ok) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const saved = await saveSkills(hero.id, plan, force ? undefined : progress.updatedAt);
      setPlan(planFrom(saved));
      prevSaved.current = saved.skills;
      setJustSaved(true);
      uiSound('ui-confirm');
      setTimeout(() => setJustSaved(false), 1800);
    } catch (err) {
      uiSound('ui-error');
      const failure = classifySaveError(err);
      if (failure.kind === 'conflict') setConflict(failure.message);
      else setError(failure.message);
    } finally {
      setBusy(false);
    }
  };

  const doHeal = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await healHero(hero.id);
      uiSound('ui-confirm');
    } catch (err) {
      uiSound('ui-error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const reload = () => {
    setPlan(planFrom(progress));
    setConflict(null);
    setError(null);
  };

  return (
    <div className="mt-4 space-y-4" data-testid="hero-stats-sheet">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="grid size-14 shrink-0 place-items-center rounded-xl bg-ink-700 ring-2 ring-cozy" aria-label={`Level ${progress.level}`}>
          <div className="text-center leading-none">
            <p className="text-[9px] uppercase tracking-widest text-ink-400">Level</p>
            <p className="font-mono text-xl font-bold text-cozy">{progress.level}</p>
          </div>
        </div>
        <div className="min-w-48 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-ink-100">{battleLabel(style, 'class', progress.classId)}</span>
            <span className="rounded-full bg-ink-700 px-2 py-0.5 text-[10px] text-ink-300">{battleLabel(style, 'type', CLASS_TYPE[progress.classId])}</span>
          </div>
          <div
            className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-ink-800"
            role="progressbar"
            aria-label="Experience"
            aria-valuemin={0}
            aria-valuemax={span ?? 1}
            aria-valuenow={span === null ? 1 : Math.min(into, span)}
            aria-valuetext={span === null ? 'Max level' : `${fmt(into)} of ${fmt(span)} XP to the next level`}
          >
            <div className="h-full rounded-full bg-cozy transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 font-mono text-[10px] text-ink-400">{span === null ? 'MAX' : `${fmt(into)} / ${fmt(span)} XP to level ${progress.level + 1}`}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <section aria-label="Stats" className="rounded-lg bg-ink-850 p-3">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Stats</h3>
          <StatsTable current={view.current} planned={view.planned} />
        </section>
        <section aria-label="Battle record" className="rounded-lg bg-ink-850 p-3">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-400">Battle record</h3>
          <dl className="grid grid-cols-3 gap-2 text-center">
            {(
              [
                ['Wins', progress.wins],
                ['Losses', progress.losses],
                ['Fled', progress.flees],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dd className="m-0 font-mono text-lg font-bold text-ink-100">{v}</dd>
                <dt className="text-[10px] text-ink-400">{k}</dt>
              </div>
            ))}
          </dl>
          {knockedOut && progress.koUntil !== null && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-red-950/40 p-2 text-xs text-red-200" role="status">
              <span>
                💫 Knocked out, back at{' '}
                {new Date(progress.koUntil).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
              <Button variant="subtle" className="ml-auto" disabled={busy || !allowed} title={allowed ? 'Skip the rest' : PAIR_TO_CHANGE_MESSAGE} onClick={() => guard(() => void doHeal())}>
                ☕ Coffee break
              </Button>
            </div>
          )}
        </section>
      </div>

      <section aria-label="Skills" className="rounded-lg bg-ink-850 p-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">Skills</h3>
          <span
            className={cx('rounded-full px-2.5 py-0.5 font-mono text-xs font-bold', left > 0 ? 'bg-cozy text-ink-950' : left < 0 ? 'bg-red-900/70 text-red-100' : 'bg-ink-700 text-ink-300')}
            role="status"
            aria-label={`${left} skill points left`}
            data-testid="points-left"
          >
            {left} {Math.abs(left) === 1 ? 'point' : 'points'} left
          </span>
          <span className="text-[10px] text-ink-400">
            {pointsSpent(plan)} of {ctx.totalPoints} spent
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button
              variant="ghost"
              disabled={readOnly || !respecOk || pointsSpent(plan) === 0}
              title={!respecOk ? 'Respec is turned off for this office' : 'Take every point back, then spend them again'}
              onClick={() => {
                uiSound('ui-toggle');
                setPlan(apply(plan, { type: 'clear' }, ctx));
              }}
            >
              ↺ Respec
            </Button>
            <Button
              variant="ghost"
              disabled={busy || !dirty}
              onClick={() => {
                uiSound('ui-back');
                setPlan(planFrom(progress));
                setError(null);
              }}
            >
              Discard
            </Button>
            <Button variant="primary" disabled={readOnly || !dirty || !check.ok} onClick={() => guard(() => void doSave(false))} title={check.ok ? 'Save this build' : checkText}>
              {justSaved ? 'Saved' : 'Confirm skills'}
            </Button>
          </div>
        </div>

        {progress.overspent && (
          <p className="mb-2 rounded-md bg-amber-900/30 p-2 text-[11px] text-amber-200" role="status">
            This hero has more points spent than it has earned (the XP curve changed). Respec to rebuild it.
          </p>
        )}
        {!allowed && <p className="mb-2 text-[11px] text-ink-400">{PAIR_TO_CHANGE_MESSAGE.replace('make changes', 'change skills')}</p>}
        {dirty && !check.ok && <p className="mb-2 text-[11px] text-amber-300">{checkText}</p>}

        <SkillTreeView tree={tree} plan={plan} ctx={ctx} style={style} readOnly={readOnly} onOp={(op) => setPlan(apply(plan, op, ctx))} />
        <p className="mt-2 text-[10px] text-ink-400">Tab to a skill, then press + to learn or − to unlearn. Nothing is saved until you confirm.</p>
      </section>

      {conflict && (
        <div className="rounded-md bg-amber-900/30 p-3 text-xs text-amber-100" role="alert">
          <p>{conflict}. Someone else changed this hero's skills.</p>
          <div className="mt-2 flex gap-2">
            <Button variant="subtle" onClick={reload}>
              Reload
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => guard(() => void doSave(true))}>
              Overwrite
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="text-[11px] text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
