// M14 W0w STUB: applies every action and plays all its events at once (`busy` is always false). G1 owns the real
// timeline (docs/design/battles.md 3.5).
import { applyAction, createBattle, type BattleEvent, type BattleSetup, type PlayerAction } from '@tagconn/shared';
import type { BattleController, BattleView, CreateBattleController, TimelineItem } from './types';

export const createBattleController: CreateBattleController = (setup: BattleSetup, opts) => {
  let state = createBattle(setup);
  const log: PlayerAction[] = [];
  const subs = new Set<(v: BattleView) => void>();
  const lines: string[] = [];
  let current: TimelineItem | null = null;
  let result: BattleView['result'] = null;
  let seq = 0;
  let destroyed = false;

  const view = (): BattleView => ({ setup, state, current, busy: false, lines, result });
  const emit = (): void => {
    for (const cb of [...subs]) cb(view());
  };

  const play = (events: readonly BattleEvent[], after: typeof state): void => {
    for (const event of events) {
      const text = opts.text(event, setup, after);
      if (text) lines.push(text);
      current = { seq: seq++, event, text, durationMs: opts.durationMs(event, text, opts.reduced), startedAt: opts.now() };
      if (event.k === 'end') result = event.result;
    }
  };

  return {
    view,
    subscribe: (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    act: (a) => {
      if (destroyed) return { ok: false, error: 'destroyed' };
      const r = applyAction(setup, state, a);
      if (!r.ok) return { ok: false, error: r.error };
      state = r.state;
      log.push(a);
      play(r.events, r.state);
      emit();
      return { ok: true };
    },
    tick: () => {},
    skip: () => {},
    actionLog: () => log,
    destroy: () => {
      destroyed = true;
      subs.clear();
    },
  } satisfies BattleController;
};
