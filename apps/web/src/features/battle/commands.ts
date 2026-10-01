// M14 W0w STUB: P1 wires these to the REST routes and demo mode (docs/design/battles.md 2.4, 3.9).
import type { BattleCreate, BattleOutcome, BattleResolve, BattleStart, HeroProgress, LootId, SkillAllocation } from '@tagconn/shared';

const nope = (): never => {
  throw new Error('not implemented');
};

export const startBattle = (_b: BattleCreate): Promise<BattleStart> => nope();
export const resolveBattle = (_id: string, _b: BattleResolve): Promise<BattleOutcome> => nope();
export const abandonBattle = (_id: string): Promise<void> => nope();
export const saveSkills = (_heroId: string, _skills: SkillAllocation, _baseUpdatedAt?: number): Promise<HeroProgress> => nope();
export const equipTitle = (_heroId: string, _title: LootId | null): Promise<HeroProgress> => nope();
export const healHero = (_heroId: string): Promise<HeroProgress> => nope();
