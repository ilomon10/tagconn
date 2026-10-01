import { describe, expect, it, vi } from 'vitest';
import type { BattleSceneInput } from '../types';

// OfficeGame without a renderer: Phaser.Game, the office scene and the battle launcher are stubs.
const launch = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('phaser', () => ({
  AUTO: 0,
  Scale: { RESIZE: 3 },
  Game: class {
    destroy() {}
  },
}));
vi.mock('../../scenes/OfficeScene', () => ({
  OfficeScene: class {
    constructor(public ready: (s: unknown) => void) {}
  },
}));
vi.mock('../../scenes/BattleScene', () => ({ launchBattle: launch.fn }));

import { OfficeGame } from '../../OfficeGame';

const input = {} as BattleSceneInput;

function makeGame() {
  const setBattleActive = vi.fn();
  const g = new OfficeGame({ clientWidth: 1, clientHeight: 1 } as HTMLElement);
  // The mocked scene constructor kept the ready callback; fish it out through the game's private scene field.
  (g as unknown as { scene: unknown }).scene = { setBattleActive, events: { on() {} } };
  return { g, setBattleActive };
}

describe('OfficeGame.openBattle', () => {
  it('a launch that closes synchronously leaves no dead handle behind', () => {
    const { g, setBattleActive } = makeGame();
    launch.fn.mockImplementationOnce((_game: unknown, _in: unknown, onClosed: () => void) => {
      onClosed();
      return { ready: Promise.resolve(), setInsets() {}, close: () => Promise.resolve(), destroy() {} };
    });
    expect(g.openBattle(input)).toBeNull();
    expect(g.battleOpen).toBe(false);
    expect(setBattleActive).toHaveBeenLastCalledWith(false);
    // a later battle can open
    const handle = { ready: Promise.resolve(), setInsets() {}, close: () => Promise.resolve(), destroy() {} };
    launch.fn.mockImplementationOnce(() => handle);
    expect(g.openBattle(input)).toBe(handle);
    expect(g.battleOpen).toBe(true);
  });

  it('a normal close clears the handle', () => {
    const { g } = makeGame();
    let closed: () => void = () => {};
    launch.fn.mockImplementationOnce((_g: unknown, _i: unknown, onClosed: () => void) => {
      closed = onClosed;
      return { ready: Promise.resolve(), setInsets() {}, close: () => Promise.resolve(), destroy() {} };
    });
    expect(g.openBattle(input)).not.toBeNull();
    expect(g.openBattle(input)).toBeNull(); // one at a time
    closed();
    expect(g.battleOpen).toBe(false);
  });
});
