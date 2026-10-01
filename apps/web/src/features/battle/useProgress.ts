import { useEffect, useState } from 'react';
import { levelForXp, xpFromUsage, type Agent, type Hero, type HeroProgress, type LevelCurve, type Settings } from '@tagconn/shared';
import { getProgress, useProgressStore } from '../../stores/progressStore';
import { useSettingsStore } from '../../stores/settingsStore';

/** The level shown on a badge: a hero's stored level, or an anonymous agent's temporary level ("~N") from its own usage. */
export interface AgentLevel { level: number; temporary: boolean }

/** Longest single timer (setTimeout overflows past 2^31 - 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Pure core of `useAgentLevel` (tested). Null when progression is off, or when there is nothing to show. */
export function agentLevelFor(
  agent: Pick<Agent, 'usage'>,
  hero: Pick<Hero, 'id'> | undefined,
  progress: HeroProgress | undefined,
  settings: Pick<Settings, 'progression'>,
): AgentLevel | null {
  const p = settings.progression;
  if (!p.enabled) return null;
  if (hero) return { level: progress?.level ?? 1, temporary: false };
  if (!agent.usage) return null;
  const curve: LevelCurve = p;
  const xp = xpFromUsage(agent.usage, p.xpWeights);
  if (xp <= 0) return null;
  return { level: levelForXp(xp, curve), temporary: true };
}

/** ms until the next wake-up at `untilTs` (null when there is none, or it has passed); clamped to a safe timer length. */
export function wakeDelay(untilTs: number | null | undefined, now: number): number | null {
  if (untilTs == null || !(untilTs > now)) return null;
  return Math.min(MAX_TIMER_MS, untilTs - now + 1);
}

export function useHeroProgress(heroId: string | null | undefined): HeroProgress | undefined {
  return useProgressStore((s) => (heroId ? getProgress(s.progress, heroId) : undefined));
}

export function useAgentLevel(agent: Pick<Agent, 'usage'>, hero: Pick<Hero, 'id'> | undefined): AgentLevel | null {
  const progress = useHeroProgress(hero?.id);
  const progression = useSettingsStore((s) => s.settings.progression);
  const usage = agent.usage;
  const enabled = progression.enabled;
  // Anonymous agents recompute from usage; heroes read the stored level.
  return agentLevelFor({ usage }, hero, progress, { progression: { ...progression, enabled } });
}

/** `Date.now()` that re-renders once at `untilTs` (the next `koUntil`), so a KO badge clears itself. */
export function useNow(untilTs?: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t0 = Date.now();
    setNow(t0);
    const delay = wakeDelay(untilTs, t0);
    if (delay === null) return;
    const id = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(id);
  }, [untilTs]);
  return now;
}
