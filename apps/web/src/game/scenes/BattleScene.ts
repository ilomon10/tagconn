// M14 W0w STUB: G2 owns the real scene (docs/design/battles.md 3.5).
import * as Phaser from 'phaser';
import { BATTLE_SCENE_KEY, type BattleSceneHandle, type BattleSceneInput, type LaunchBattle } from '../battle/types';

export class BattleScene extends Phaser.Scene {
  constructor() {
    super({ key: BATTLE_SCENE_KEY });
  }

  create(): void {}
}

export const launchBattle: LaunchBattle = (_game: Phaser.Game, _input: BattleSceneInput, onClosed: () => void): BattleSceneHandle => {
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    onClosed();
  };
  return {
    ready: Promise.resolve(),
    setInsets: () => {},
    close: () => {
      finish();
      return Promise.resolve();
    },
    destroy: finish,
  };
};
