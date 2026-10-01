import { describe, expect, it } from 'vitest';
import { applyAction, createBattle, type BattleSetup, type BattleState } from '@tagconn/shared';
import { M, hero, setup } from '../../../../../../../packages/shared/src/battle/__tests__/fixtures';
import { effectivenessLabel, keyToInput, MENU_INITIAL, menuEntries, menuReducer, normalizeMenu, type MenuCtx, type MenuInput, type MenuState } from '../menuModel';

const mk = (su: BattleSetup = setup(), patch: Partial<BattleState> = {}, busy = false): MenuCtx => ({ setup: su, battle: { ...createBattle(su), ...patch }, busy });
function run(ctx: MenuCtx, inputs: MenuInput[], from: MenuState = MENU_INITIAL) {
  let state = from;
  let last = menuReducer(state, { t: 'move', dir: 'up' }, ctx);
  for (const i of inputs) {
    last = menuReducer(state, i, ctx);
    state = last.state;
  }
  return last;
}
const down: MenuInput = { t: 'move', dir: 'down' };
const confirm: MenuInput = { t: 'confirm' };

describe('root navigation', () => {
  const ctx = mk();
  it('lists Fight/Skill/Item/Swap/Run in two columns', () => {
    expect(menuEntries(MENU_INITIAL, ctx).map((e) => e.kind)).toEqual(['fight', 'skill', 'item', 'swap', 'run']);
    const r = (i: MenuInput[]) => run(ctx, i).state.cursor;
    expect(r([{ t: 'move', dir: 'right' }])).toBe(1);
    expect(r([down])).toBe(2);
    expect(r([down, down])).toBe(4);
    expect(r([{ t: 'move', dir: 'left' }])).toBe(0);
    expect(r([{ t: 'move', dir: 'up' }])).toBe(0);
    expect(r([{ t: 'move', dir: 'right' }, { t: 'move', dir: 'right' }])).toBe(1); // no wrap
  });
  it('plays a hover sound only when the cursor actually moved', () => {
    expect(menuReducer(MENU_INITIAL, { t: 'move', dir: 'right' }, ctx).sfx).toBe('ui-hover');
    expect(menuReducer(MENU_INITIAL, { t: 'move', dir: 'up' }, ctx).sfx).toBeUndefined();
  });
  it('digits jump, out-of-range digits do nothing', () => {
    expect(run(ctx, [{ t: 'digit', n: 4 }]).state.cursor).toBe(3);
    expect(run(ctx, [{ t: 'digit', n: 9 }]).state.cursor).toBe(0);
  });
  it('Fight sends move 0; Run sends run', () => {
    expect(run(ctx, [confirm])).toMatchObject({ action: { t: 'move', move: 0 }, sfx: 'ui-confirm' });
    expect(run(ctx, [{ t: 'click', index: 4 }]).action).toEqual({ t: 'run' });
  });
  it('Back on the root does nothing (never closes the battle)', () => {
    const r = menuReducer(MENU_INITIAL, { t: 'back' }, ctx);
    expect(r).toEqual({ state: MENU_INITIAL });
  });
});

describe('skill list', () => {
  it('lists moves 1..n, disables unaffordable ones, errors on them', () => {
    const su = setup();
    const ctx = mk(su, { party: createBattle(su).party.map((p, i) => (i === 0 ? { ...p, focus: 7 } : p)) });
    const skill = run(ctx, [{ t: 'digit', n: 2 }, confirm]).state;
    expect(skill.screen).toBe('skill');
    const entries = menuEntries(skill, ctx);
    expect(entries.map((e) => [e.kind, e.index, e.disabled])).toEqual([
      ['move', 1, true], ['move', 2, true], ['move', 3, true], ['move', 4, false], ['move', 5, false], ['back', undefined, false],
    ]);
    expect(entries[0]!.reason).toBe('focus');
    expect(skill.cursor).toBe(3); // opens on the first usable move
    const bad = menuReducer({ ...skill, cursor: 0 }, confirm, ctx);
    expect(bad).toMatchObject({ sfx: 'ui-error' });
    expect(bad.action).toBeUndefined();
    expect(bad.state).toEqual({ ...skill, cursor: 0 });
    const ok = menuReducer({ ...skill, cursor: 3 }, confirm, ctx);
    expect(ok.action).toEqual({ t: 'move', move: 4 });
    expect(ok.state).toEqual(MENU_INITIAL);
  });
  it('Skill is disabled for a combatant with only a basic attack', () => {
    const ctx = mk(setup({ party: [hero({ moves: [M.basic] })] }));
    const e = menuEntries(MENU_INITIAL, ctx)[1]!;
    expect(e).toMatchObject({ kind: 'skill', disabled: true });
    expect(menuReducer({ ...MENU_INITIAL, cursor: 1 }, confirm, ctx)).toMatchObject({ sfx: 'ui-error' });
  });
  it('Back returns to the root with the cursor where it was', () => {
    const ctx = mk();
    const r = run(ctx, [{ t: 'digit', n: 2 }, confirm, { t: 'back' }]);
    expect(r.state).toMatchObject({ screen: 'root', cursor: 1, stack: [] });
    expect(r.sfx).toBe('ui-back');
  });
  it('lists wrap vertically', () => {
    const ctx = mk();
    const skill = run(ctx, [{ t: 'digit', n: 2 }, confirm]).state;
    expect(menuReducer(skill, { t: 'move', dir: 'up' }, ctx).state.cursor).toBe(menuEntries(skill, ctx).length - 1);
  });
});

describe('items', () => {
  it('heal asks for a target; self sends no target, bench sends its index', () => {
    const ctx = mk();
    const item = run(ctx, [{ t: 'digit', n: 3 }, confirm]).state;
    expect(item.screen).toBe('item');
    const coffee = menuReducer(item, confirm, ctx);
    expect(coffee.state).toMatchObject({ screen: 'itemTarget', itemIndex: 0 });
    expect(menuEntries(coffee.state, ctx).map((e) => e.kind)).toEqual(['target', 'target', 'back']);
    expect(menuReducer(coffee.state, confirm, ctx).action).toEqual({ t: 'item', item: 0 });
    expect(menuReducer({ ...coffee.state, cursor: 1 }, confirm, ctx).action).toEqual({ t: 'item', item: 0, target: 1 });
    // Back from the target list lands on the item list
    expect(menuReducer(coffee.state, { t: 'back' }, ctx).state).toMatchObject({ screen: 'item', cursor: 0 });
  });
  it('focus / party items fire immediately; empty stacks are disabled with an error', () => {
    const su = setup();
    const ctx = mk(su, { items: [0, 1, 1, 1] });
    const entries = menuEntries({ ...MENU_INITIAL, screen: 'item' }, ctx);
    expect(entries[0]).toMatchObject({ disabled: true, reason: 'empty' });
    expect(entries[1]!.action).toEqual({ t: 'item', item: 1 });
    expect(entries[3]!.action).toEqual({ t: 'item', item: 3 });
    expect(menuReducer({ ...MENU_INITIAL, screen: 'item', stack: [MENU_INITIAL] }, confirm, ctx).sfx).toBe('ui-error');
  });
  it('Item is disabled with no items left', () => {
    const ctx = mk(setup(), { items: [0, 0, 0, 0] });
    expect(menuEntries(MENU_INITIAL, ctx)[2]).toMatchObject({ disabled: true, reason: 'empty' });
  });
});

describe('swap and forced swap', () => {
  it('lists living bench members only', () => {
    const su = setup();
    const b = createBattle(su);
    const ctx = mk(su, { party: [b.party[0]!, { ...b.party[1]!, fainted: true, hp: 0 }] });
    expect(menuEntries(MENU_INITIAL, ctx)[3]).toMatchObject({ kind: 'swap', disabled: true });
    expect(menuEntries({ ...MENU_INITIAL, screen: 'swap' }, ctx).map((e) => e.kind)).toEqual(['back']);
  });
  it('a fainted active member forces the Swap list with Back disabled', () => {
    const su = setup();
    const b = createBattle(su);
    const ctx = mk(su, { phase: 'forced-swap', party: [{ ...b.party[0]!, fainted: true, hp: 0 }, b.party[1]!] });
    const s = normalizeMenu(MENU_INITIAL, ctx);
    expect(s).toMatchObject({ screen: 'swap', forced: true });
    expect(menuEntries(s, ctx).map((e) => e.kind)).toEqual(['swapTo']);
    expect(menuReducer(MENU_INITIAL, { t: 'back' }, ctx).sfx).toBeUndefined();
    const r = menuReducer(MENU_INITIAL, confirm, ctx);
    expect(r.action).toEqual({ t: 'swap', to: 1 });
    expect(r.state).toEqual(MENU_INITIAL);
  });
  it('leaves the forced list once the battle is back to choosing', () => {
    const ctx = mk();
    expect(normalizeMenu({ screen: 'swap', cursor: 0, itemIndex: null, stack: [], forced: true }, ctx)).toEqual(MENU_INITIAL);
  });
  it('works against the real engine: the offered swap is accepted', () => {
    const su = setup();
    const ctx = mk(su);
    const r = run(ctx, [{ t: 'digit', n: 4 }, confirm, confirm]);
    expect(r.action).toEqual({ t: 'swap', to: 1 });
    expect(applyAction(su, ctx.battle, r.action!).ok).toBe(true);
  });
});

describe('busy', () => {
  const ctx = mk(setup(), {}, true);
  it('confirm and click ask to skip; nothing is sent', () => {
    expect(menuReducer(MENU_INITIAL, confirm, ctx)).toEqual({ state: MENU_INITIAL, skip: true });
    expect(menuReducer(MENU_INITIAL, { t: 'click', index: 4 }, ctx)).toMatchObject({ skip: true });
    expect(menuReducer(MENU_INITIAL, { t: 'click', index: 4 }, ctx).action).toBeUndefined();
  });
  it('navigation still works and back is inert', () => {
    expect(menuReducer(MENU_INITIAL, down, ctx).state.cursor).toBe(2);
    expect(menuReducer(MENU_INITIAL, { t: 'back' }, ctx)).toEqual({ state: MENU_INITIAL });
  });
  it('an ended battle behaves like busy and disables everything', () => {
    const over = mk(setup(), { phase: 'ended', result: 'won' });
    expect(menuReducer(MENU_INITIAL, confirm, over).skip).toBe(true);
    expect(menuEntries(MENU_INITIAL, over).every((e) => e.disabled)).toBe(true);
  });
});

describe('mouse', () => {
  it('hover moves the cursor, click confirms that row', () => {
    const ctx = mk();
    expect(menuReducer(MENU_INITIAL, { t: 'hover', index: 3 }, ctx).state.cursor).toBe(3);
    expect(menuReducer(MENU_INITIAL, { t: 'hover', index: 99 }, ctx).state).toEqual(MENU_INITIAL);
    expect(menuReducer(MENU_INITIAL, { t: 'click', index: 1 }, ctx).state.screen).toBe('skill');
  });
});

describe('keyToInput', () => {
  it('maps keys', () => {
    expect(keyToInput({ key: 'ArrowUp' })).toEqual({ t: 'move', dir: 'up' });
    expect(keyToInput({ key: 'a' })).toEqual({ t: 'move', dir: 'left' });
    expect(keyToInput({ key: 'Enter' })).toEqual(confirm);
    expect(keyToInput({ key: ' ' })).toEqual(confirm);
    expect(keyToInput({ key: 'z' })).toEqual(confirm);
    for (const k of ['Escape', 'x', 'Backspace']) expect(keyToInput({ key: k })).toEqual({ t: 'back' });
    expect(keyToInput({ key: '3' })).toEqual({ t: 'digit', n: 3 });
    expect(keyToInput({ key: 'Enter', ctrlKey: true })).toBeNull();
    expect(keyToInput({ key: 'q' })).toBeNull();
  });
});

describe('effectivenessLabel', () => {
  it('names only the notable cases', () => {
    expect(effectivenessLabel('super')).toBe('Super effective');
    expect(effectivenessLabel('weak')).toBe('Not very effective');
    expect(effectivenessLabel('normal')).toBeNull();
  });
});
