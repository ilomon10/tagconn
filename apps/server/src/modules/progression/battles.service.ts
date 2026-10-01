import type { BattleCreate, BattleOutcome, BattleResolve, BattleStart, BattleStatus } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { HttpError } from '../../core/http/errors.js';

const notImplemented = (): never => {
  throw new HttpError(501, 'Not implemented');
};

/** S1 stub: S3 owns the bodies (docs/design/battles.md 2.5). */
export class BattlesService {
  constructor(protected readonly deps: Deps<'battlesRepository' | 'progressionRepository' | 'bus' | 'settings' | 'logger'>) {}

  start(): void {}
  stop(): void {}

  create(_body: BattleCreate, _now?: number): BattleStart {
    return notImplemented();
  }
  resolve(_id: string, _body: BattleResolve, _now?: number): BattleOutcome {
    return notImplemented();
  }
  abandon(_id: string, _now?: number): { status: BattleStatus } {
    return notImplemented();
  }
  get(_id: string): BattleStart & { outcome: BattleOutcome | null } {
    return notImplemented();
  }
}
