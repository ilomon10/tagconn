import type { BattleCreate, BattleOutcome, BattleResolve, BattleStart, HeroProgress, LootId, SkillAllocation } from '@tagconn/shared';
import { api } from '../../lib/api';
import { useOfficeStore } from '../../stores/officeStore';
import * as demo from './demoProgression';

/**
 * Battle and progression commands (docs/design/battles.md 3.9 P1): live calls go to the REST routes (the server pushes
 * `hero:progress` back), demo mode runs the same engine locally. Errors are `ApiError` in both.
 */

const inDemo = (): boolean => useOfficeStore.getState().connection === 'demo';

export const startBattle = (b: BattleCreate): Promise<BattleStart> => (inDemo() ? run(() => demo.createBattle(b)) : api.createBattle(b));
export const resolveBattle = (id: string, b: BattleResolve): Promise<BattleOutcome> => (inDemo() ? run(() => demo.resolveBattle(id, b)) : api.resolveBattle(id, b));
export const abandonBattle = async (id: string): Promise<void> => {
  if (inDemo()) await run(() => demo.abandonBattle(id));
  else await api.abandonBattle(id);
};
export const saveSkills = (heroId: string, skills: SkillAllocation, baseSkillsUpdatedAt?: number): Promise<HeroProgress> =>
  inDemo() ? run(() => demo.saveSkills(heroId, skills, baseSkillsUpdatedAt)) : api.saveSkills(heroId, { skills: { ...skills }, baseSkillsUpdatedAt });
export const equipTitle = (heroId: string, title: LootId | null): Promise<HeroProgress> => (inDemo() ? run(() => demo.equipTitle(heroId, title)) : api.equipTitle(heroId, { title }));
export const healHero = (heroId: string): Promise<HeroProgress> => (inDemo() ? run(() => demo.healHero(heroId)) : api.healHero(heroId));

/** Demo functions throw synchronously; commands always reject instead. */
const run = <T>(fn: () => T): Promise<T> => {
  try {
    return Promise.resolve(fn());
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
};
