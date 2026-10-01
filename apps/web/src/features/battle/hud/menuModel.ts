// Pure command-menu state machine for the battle HUD (docs/design/battles.md 3.6). No React, no audio: it returns
// the sound id and the action, the component plays/sends them.
import { damagePreview, type BattleSetup, type BattleState, type Effectiveness, type PlayerAction } from '@tagconn/shared';
import type { SfxId } from '../../../game/sfxBus';

export type MenuScreen = 'root' | 'skill' | 'item' | 'itemTarget' | 'swap';
export interface MenuFrame { screen: MenuScreen; cursor: number; itemIndex: number | null }
export interface MenuState extends MenuFrame {
  /** Screens to return to on Back, oldest first. */
  stack: readonly MenuFrame[];
  /** The Swap list was opened by a fainted active member: Back is disabled until a swap is made. */
  forced: boolean;
}
export interface MenuCtx { setup: BattleSetup; battle: BattleState; busy: boolean }

export type MenuInput =
  | { t: 'move'; dir: 'up' | 'down' | 'left' | 'right' }
  | { t: 'confirm' }
  | { t: 'back' }
  | { t: 'digit'; n: number }
  | { t: 'hover'; index: number }
  | { t: 'click'; index: number };

export type MenuEntryKind = 'fight' | 'skill' | 'item' | 'swap' | 'run' | 'move' | 'useItem' | 'target' | 'swapTo' | 'back';
export type DisabledReason = 'focus' | 'empty' | 'none' | 'ended';
export interface MenuEntry {
  kind: MenuEntryKind;
  /** Move index (`move`), item index (`useItem`), party member index (`target`, `swapTo`). */
  index?: number;
  disabled: boolean;
  reason?: DisabledReason;
  /** Sent to the controller when the entry is confirmed. */
  action?: PlayerAction;
  /** Opens this screen when confirmed. */
  goto?: MenuScreen;
}

export interface MenuResult {
  state: MenuState;
  action?: PlayerAction;
  /** Busy: the confirm/click means "skip the current line". */
  skip?: true;
  sfx?: SfxId;
}

export const ROOT_COLUMNS = 2;
export const MENU_INITIAL: MenuState = { screen: 'root', cursor: 0, itemIndex: null, stack: [], forced: false };

const dead = (b: BattleState, i: number): boolean => b.party[i]?.fainted !== false;

/** Which entries the current screen lists (labels are the component's job). */
export function menuEntries(state: MenuState, ctx: MenuCtx): MenuEntry[] {
  const { setup, battle } = ctx;
  const over = battle.phase === 'ended';
  const me = setup.party[battle.active];
  const meState = battle.party[battle.active];
  const off = (reason: DisabledReason): Pick<MenuEntry, 'disabled' | 'reason'> => ({ disabled: true, reason });
  const on = { disabled: false } as const;
  const back: MenuEntry = { kind: 'back', disabled: state.forced };

  switch (state.screen) {
    case 'root': {
      const basic = me?.moves[0];
      const fightOk = !!basic && !!meState && meState.focus >= basic.focusCost;
      const hasSkill = (me?.moves.length ?? 0) > 1;
      const hasItem = setup.items.some((_, i) => (battle.items[i] ?? 0) > 0);
      const hasBench = battle.party.some((_, i) => i !== battle.active && !dead(battle, i));
      return [
        { kind: 'fight', action: { t: 'move', move: 0 }, ...(over ? off('ended') : fightOk ? on : off('focus')) },
        { kind: 'skill', goto: 'skill', ...(over ? off('ended') : hasSkill ? on : off('none')) },
        { kind: 'item', goto: 'item', ...(over ? off('ended') : hasItem ? on : off('empty')) },
        { kind: 'swap', goto: 'swap', ...(over ? off('ended') : hasBench ? on : off('none')) },
        { kind: 'run', action: { t: 'run' }, ...(over ? off('ended') : on) },
      ];
    }
    case 'skill': {
      const out: MenuEntry[] = [];
      me?.moves.forEach((m, i) => {
        if (i === 0) return;
        out.push({ kind: 'move', index: i, action: { t: 'move', move: i }, ...(over ? off('ended') : (meState?.focus ?? 0) >= m.focusCost ? on : off('focus')) });
      });
      return [...out, back];
    }
    case 'item': {
      const out = setup.items.map<MenuEntry>((it, i) => {
        const left = (battle.items[i] ?? 0) > 0;
        const needsTarget = it.def.effect === 'heal' || it.def.effect === 'cure';
        return {
          kind: 'useItem',
          index: i,
          ...(over ? off('ended') : left ? on : off('empty')),
          ...(needsTarget ? { goto: 'itemTarget' as const } : { action: { t: 'item', item: i } as PlayerAction }),
        };
      });
      return [...out, back];
    }
    case 'itemTarget': {
      const item = state.itemIndex ?? 0;
      const out: MenuEntry[] = [];
      battle.party.forEach((_, i) => {
        if (dead(battle, i)) return;
        // The engine reads "no target" as the active member.
        out.push({ kind: 'target', index: i, ...on, action: i === battle.active ? { t: 'item', item } : { t: 'item', item, target: i } });
      });
      return [...out, back];
    }
    case 'swap': {
      const out: MenuEntry[] = [];
      battle.party.forEach((_, i) => {
        if (i === battle.active || dead(battle, i)) return;
        out.push({ kind: 'swapTo', index: i, ...(over ? off('ended') : on), action: { t: 'swap', to: i } });
      });
      return state.forced ? out : [...out, back];
    }
  }
}

/** Reconciles the menu with the battle: a fainted active member forces the Swap list; the cursor stays in range. */
export function normalizeMenu(state: MenuState, ctx: MenuCtx): MenuState {
  let s = state;
  if (ctx.battle.phase === 'forced-swap') {
    if (!s.forced || s.screen !== 'swap') s = { screen: 'swap', cursor: 0, itemIndex: null, stack: [], forced: true };
  } else if (s.forced) {
    s = MENU_INITIAL;
  }
  const n = menuEntries(s, ctx).length;
  if (n === 0) return s.screen === 'root' ? s : MENU_INITIAL;
  if (s.cursor >= n) s = { ...s, cursor: n - 1 };
  return s;
}

const firstEnabled = (entries: readonly MenuEntry[]): number => Math.max(0, entries.findIndex((e) => !e.disabled));

function moveCursor(state: MenuState, n: number, dir: 'up' | 'down' | 'left' | 'right'): number {
  const c = state.cursor;
  if (state.screen === 'root') {
    if (dir === 'up') return c - ROOT_COLUMNS >= 0 ? c - ROOT_COLUMNS : c;
    if (dir === 'down') return c + ROOT_COLUMNS < n ? c + ROOT_COLUMNS : c;
    if (dir === 'left') return c % ROOT_COLUMNS === 1 ? c - 1 : c;
    return c % ROOT_COLUMNS === 0 && c + 1 < n ? c + 1 : c;
  }
  if (dir === 'up') return (c - 1 + n) % n;
  if (dir === 'down') return (c + 1) % n;
  return c;
}

function goBack(state: MenuState): MenuResult {
  const prev = state.stack[state.stack.length - 1];
  if (state.forced || !prev) return { state }; // never closes the battle; nothing to go back to
  return { state: { ...prev, stack: state.stack.slice(0, -1), forced: false }, sfx: 'ui-back' };
}

function confirm(state: MenuState, ctx: MenuCtx): MenuResult {
  const entries = menuEntries(state, ctx);
  const e = entries[state.cursor];
  if (!e) return { state };
  if (e.kind === 'back') return e.disabled ? { state, sfx: 'ui-error' } : goBack(state);
  if (e.disabled) return { state, sfx: 'ui-error' };
  if (e.action) return { state: MENU_INITIAL, action: e.action, sfx: 'ui-confirm' };
  if (e.goto) {
    const frame: MenuFrame = { screen: state.screen, cursor: state.cursor, itemIndex: state.itemIndex };
    const next: MenuState = { screen: e.goto, cursor: 0, itemIndex: e.goto === 'itemTarget' ? (e.index ?? null) : state.itemIndex, stack: [...state.stack, frame], forced: false };
    return { state: { ...next, cursor: firstEnabled(menuEntries(next, ctx)) }, sfx: 'ui-confirm' };
  }
  return { state };
}

/**
 * One menu input. While `busy` (or the battle is over) confirm/click ask to skip the current line instead and
 * navigation still works, so the cursor is where the player expects it when the commands come back.
 */
export function menuReducer(raw: MenuState, input: MenuInput, ctx: MenuCtx): MenuResult {
  const state = normalizeMenu(raw, ctx);
  const n = menuEntries(state, ctx).length;
  const busy = ctx.busy || ctx.battle.phase === 'ended';
  const at = (cursor: number): MenuResult => (cursor === state.cursor ? { state } : { state: { ...state, cursor }, sfx: 'ui-hover' });

  switch (input.t) {
    case 'move':
      return n === 0 ? { state } : at(moveCursor(state, n, input.dir));
    case 'digit':
      return input.n >= 1 && input.n <= n ? at(input.n - 1) : { state };
    case 'hover':
      return input.index >= 0 && input.index < n ? at(input.index) : { state };
    case 'back':
      return busy ? { state } : goBack(state);
    case 'confirm':
      return busy ? { state, skip: true } : confirm(state, ctx);
    case 'click': {
      if (busy) return { state, skip: true };
      if (input.index < 0 || input.index >= n) return { state };
      return confirm({ ...state, cursor: input.index }, ctx);
    }
  }
}

/** Keyboard mapping (arrows/WASD move, Enter/Space/Z confirm, Esc/X/Backspace back, digits jump); null = not ours. */
export function keyToInput(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): MenuInput | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case 'ArrowUp': case 'w': case 'W': return { t: 'move', dir: 'up' };
    case 'ArrowDown': case 's': case 'S': return { t: 'move', dir: 'down' };
    case 'ArrowLeft': case 'a': case 'A': return { t: 'move', dir: 'left' };
    case 'ArrowRight': case 'd': case 'D': return { t: 'move', dir: 'right' };
    case 'Enter': case ' ': case 'z': case 'Z': return { t: 'confirm' };
    case 'Escape': case 'x': case 'X': case 'Backspace': return { t: 'back' };
    default:
      return /^[1-9]$/.test(e.key) ? { t: 'digit', n: Number(e.key) } : null;
  }
}

/** "Super effective" / "Not very effective", or null for a normal hit. */
export function effectivenessLabel(eff: Effectiveness): string | null {
  return eff === 'super' ? 'Super effective' : eff === 'weak' ? 'Not very effective' : null;
}

/** The active member's damage preview for a move (null for non-attacks). */
export function movePreview(ctx: MenuCtx, move: number) {
  return damagePreview(ctx.setup, ctx.battle, move);
}
