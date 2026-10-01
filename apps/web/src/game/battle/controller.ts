// Battle controller (docs/design/battles.md 3.5): pure TS, no Phaser/React. `act` runs the engine at once and queues the
// resulting events; `tick`/`skip` play them one at a time so the scene and the HUD share one timeline.
import { applyAction, createBattle, type BattleEvent, type BattleSetup, type PlayerAction } from '@tagconn/shared';
import type { BattleController, BattleView, CreateBattleController, TimelineItem } from './types';

interface Pending { event: BattleEvent; text: string; durationMs: number }

export const createBattleController: CreateBattleController = (setup: BattleSetup, opts) => {
  let state = createBattle(setup); // after every queued event; the HUD animates toward the item in `current`
  const log: PlayerAction[] = [];
  const subs = new Set<(v: BattleView) => void>();
  const queue: Pending[] = [];
  let lines: readonly string[] = [];
  let current: TimelineItem | null = null;
  let playing = false; // `current` has not finished yet
  let result: BattleView['result'] = null;
  let seq = 0;
  let destroyed = false;
  let cached: BattleView | null = null;

  const build = (): BattleView => ({ setup, state, current, busy: playing || queue.length > 0, lines, result });
  const view = (): BattleView => (cached ??= build());
  const emit = (): void => {
    cached = null;
    const v = view();
    for (const cb of [...subs]) cb(v);
  };

  /** Finish the playing item (setting `result` after the end event) and start the next one at `at`. */
  const advance = (at: number): void => {
    if (playing && current) {
      playing = false;
      if (current.event.k === 'end') result = current.event.result;
    }
    const next = queue.shift();
    if (!next) return;
    current = { seq: seq++, event: next.event, text: next.text, durationMs: next.durationMs, startedAt: at };
    playing = true;
    if (next.text) lines = [...lines, next.text];
  };

  return {
    view,
    subscribe: (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    act: (a) => {
      if (destroyed) return { ok: false, error: 'destroyed' };
      if (playing || queue.length > 0) return { ok: false, error: 'busy' };
      const r = applyAction(setup, state, a);
      if (!r.ok) return { ok: false, error: r.error };
      state = r.state;
      log.push(a);
      for (const event of r.events) {
        const text = opts.text(event, setup, r.state);
        const d = opts.durationMs(event, text, opts.reduced);
        queue.push({ event, text, durationMs: Number.isFinite(d) && d > 0 ? d : 0 });
      }
      advance(opts.now());
      emit();
      return { ok: true };
    },
    tick: (nowMs) => {
      if (destroyed || !playing || !current || nowMs < current.startedAt + current.durationMs) return;
      advance(nowMs);
      emit();
    },
    skip: () => {
      if (destroyed || !playing) return;
      advance(opts.now());
      emit();
    },
    actionLog: () => log,
    destroy: () => {
      destroyed = true;
      subs.clear();
    },
  } satisfies BattleController;
};
