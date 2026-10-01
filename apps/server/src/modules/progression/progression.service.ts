import type { Agent, Hero, HeroProgress, LootId, SkillAllocationRequest } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { HttpError } from '../../core/http/errors.js';

const notImplemented = (): never => {
  throw new HttpError(501, 'Not implemented');
};

/** S1 stub: S2 owns the bodies (docs/design/battles.md 2.3, 2.4). */
export class ProgressionService {
  constructor(protected readonly deps: Deps<'progressionRepository' | 'heroesRepository' | 'bus' | 'settings' | 'logger'>) {}

  seed(): void {}
  onAgentUpserted(_a: Agent, _now?: number): void {}
  onHeroUpserted(_h: Hero): void {}
  onHeroRemoved(_id: string): void {}
  onProjectMerged(_m: { from: string; into: string }): void {}

  list(_projectId?: string): HeroProgress[] {
    return notImplemented();
  }
  get(_heroId: string): HeroProgress {
    return notImplemented();
  }
  setSkills(_heroId: string, _body: SkillAllocationRequest, _now?: number): HeroProgress {
    return notImplemented();
  }
  equipTitle(_heroId: string, _title: LootId | null, _now?: number): HeroProgress {
    return notImplemented();
  }
  heal(_heroId: string, _now?: number): HeroProgress {
    return notImplemented();
  }
}
