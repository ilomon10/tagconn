import { useCallback, useEffect, useRef, useState } from 'react';
import { createBattle, type BattleEvent, type BattleOutcome, type BattleSetup, type BattleState } from '@tagconn/shared';
import { cx } from '../../../components/ui';
import { uiSound } from '../../../lib/audio/uiSound';
import { useMediaQuery } from '../../../lib/useMediaQuery';
import { useModalFocus } from '../../../lib/useModalFocus';
import type { BattleController, BattleStyle, BattleView } from '../../../game/battle/types';
import { battleLabel } from '../labels';
import { Bar } from './Bar';
import { BattleLog } from './BattleLog';
import { CommandMenu } from './CommandMenu';
import { keyToInput, MENU_INITIAL, menuReducer, normalizeMenu, type MenuInput, type MenuState } from './menuModel';
import { ResultsPanel } from './ResultsPanel';

// ------------------------------------------------------------------ display model (pure)

/** What the bars show right now: advanced one played event at a time so they trail the log, not the engine. */
export interface HudDisplay { hp: number[]; focus: number[]; enemyHp: number; enemyFocus: number; active: number }

export function displayFromState(s: Pick<BattleState, 'party' | 'enemy' | 'active'>): HudDisplay {
  return { hp: s.party.map((p) => p.hp), focus: s.party.map((p) => p.focus), enemyHp: s.enemy.hp, enemyFocus: s.enemy.focus, active: s.active };
}
export function initialDisplay(setup: BattleSetup): HudDisplay {
  return displayFromState(createBattle(setup));
}
/** Pure: the display after `e` has played. Only events that carry an absolute value move a bar. */
export function applyDisplay(d: HudDisplay, e: BattleEvent): HudDisplay {
  switch (e.k) {
    case 'damage': case 'heal': {
      if (e.target.side === 'enemy') return { ...d, enemyHp: e.hp };
      const hp = [...d.hp];
      hp[e.target.index] = e.hp;
      return { ...d, hp };
    }
    case 'focus': {
      if (e.target.side === 'enemy') return { ...d, enemyFocus: e.focus };
      const focus = [...d.focus];
      focus[e.target.index] = e.focus;
      return { ...d, focus };
    }
    case 'swap':
      return { ...d, active: e.to };
    default:
      return d;
  }
}

function useDisplay(view: BattleView): { d: HudDisplay; tweenMs: number } {
  const tracked = useRef<HudDisplay | null>(null);
  const lastSeq = useRef(-1);
  tracked.current ??= initialDisplay(view.setup);
  const cur = view.current;
  if (cur && cur.seq !== lastSeq.current) {
    // Idempotent per seq, so a double render (StrictMode) is harmless.
    lastSeq.current = cur.seq;
    tracked.current = applyDisplay(tracked.current, cur.event);
  }
  // Nothing left to play: the engine state is the truth (covers skipped or coalesced events).
  const d = view.busy ? tracked.current : displayFromState(view.state);
  if (!view.busy) tracked.current = d;
  return { d, tweenMs: cur ? cur.durationMs * 0.6 : 0 };
}

// ------------------------------------------------------------------ cards

function useEntered(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return on;
}
const ENTER = 'motion-safe:transition-[transform,opacity] motion-safe:duration-300 motion-safe:ease-[cubic-bezier(0.23,1,0.32,1)]';
const FRAME = 'rounded-lg bg-ink-950/90 p-[3px] shadow-[0_0_24px_-6px_rgba(245,192,122,0.45)] backdrop-blur';
const INNER = 'rounded-md border-2 border-cozy/70 bg-ink-900/95 px-2.5 py-2 ring-1 ring-inset ring-ink-600/70';

function Chip({ children }: { children: string }) {
  return <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-wide text-ink-200">{children}</span>;
}

// ------------------------------------------------------------------ HUD

export interface BattleHudProps {
  controller: BattleController;
  style: BattleStyle;
  reduced: boolean;
  /** The flow phase: `fighting` shows the commands, the others the results card. */
  phase: 'fighting' | 'resolving' | 'results' | 'error';
  outcome?: BattleOutcome | null;
  error?: string | null;
  onContinue: () => void;
  onOpenHero?: (heroId: string) => void;
  /** Called with the bottom panel's height in CSS px (0 when it is gone) so the stage can keep clear of it. */
  onInsets?: (bottom: number) => void;
}

export function BattleHud(props: BattleHudProps) {
  const { controller, style, phase, outcome = null, error = null, onContinue, onOpenHero, onInsets } = props;
  const prefersReduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const reduced = props.reduced || prefersReduced;
  const rootRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<BattleView>(() => controller.view());
  const [menu, setMenu] = useState<MenuState>(MENU_INITIAL);
  const [panelH, setPanelH] = useState(0);
  const entered = useEntered();
  const idPrefix = useRef(`bhud-${Math.random().toString(36).slice(2, 8)}`).current;

  useEffect(() => {
    setView(controller.view());
    return controller.subscribe(setView);
  }, [controller]);

  // The scene ticks the controller too; this keeps the log moving if the stage is not updating.
  useEffect(() => {
    if (phase !== 'fighting') return;
    let raf = 0;
    const loop = () => {
      controller.tick(performance.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [controller, phase]);

  // Esc never closes a battle: no onEscape, so the overlay stack ignores this dialog.
  useModalFocus(true, rootRef, { trap: true });

  const ctx = { setup: view.setup, battle: view.state, busy: view.busy };
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const shownMenu = normalizeMenu(menu, ctx);

  const dispatch = useCallback((input: MenuInput) => {
    const r = menuReducer(menuRef.current, input, ctxRef.current);
    menuRef.current = r.state;
    setMenu(r.state);
    if (r.skip) controller.skip();
    if (r.action) {
      const res = controller.act(r.action);
      if (!res.ok) {
        uiSound('ui-error');
        return;
      }
    }
    if (r.sfx) uiSound(r.sfx);
  }, [controller]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // Swallowed, never forwarded: leaving a battle goes through Run, not Esc.
      e.preventDefault();
      e.stopPropagation();
      if (phase !== 'fighting') return;
    }
    if (phase !== 'fighting') return;
    const input = keyToInput(e);
    if (!input) return;
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).tagName === 'BUTTON') return;
    e.preventDefault();
    dispatch(input);
  };

  const { d, tweenMs } = useDisplay(view);
  const { setup } = view;
  const active = setup.party[d.active];
  const enemy = setup.enemy;
  const enemyName = battleLabel(style, 'enemy', enemy.ref.kind === 'enemy' ? enemy.ref.npcKind : 'enemy');
  const showPanel = phase === 'fighting';

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Battle"
      data-modal="battle"
      onKeyDown={onKeyDown}
      className="pointer-events-none fixed inset-0 z-30 select-none outline-none"
    >
      {/* Enemy card */}
      <div
        role="group"
        aria-label={`Enemy: ${enemyName}, level ${enemy.level}`}
        className={cx('absolute left-3 top-3 w-56 max-w-[55vw] sm:left-5 sm:top-5 sm:w-64', FRAME, ENTER, entered ? 'translate-x-0 opacity-100' : 'opacity-0 motion-safe:-translate-x-6')}
      >
        <div className={INNER}>
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink-50">{enemyName}</span>
            <Chip>{battleLabel(style, 'type', enemy.type)}</Chip>
            <span className="font-pixel text-[10px] text-ink-300">Lv {enemy.level}</span>
          </div>
          <Bar className="mt-1.5" label="HP" kind="hp" value={d.enemyHp} max={enemy.stats.hp} tweenMs={tweenMs} reduced={reduced} />
        </div>
      </div>

      {/* Hero card */}
      {active && (
        <div
          role="group"
          aria-label={`${active.name}, level ${active.level}`}
          style={{ bottom: showPanel ? panelH + 8 : 12 }}
          className={cx('absolute right-3 w-60 max-w-[62vw] sm:right-5 sm:w-72', FRAME, ENTER, entered ? 'translate-x-0 opacity-100' : 'opacity-0 motion-safe:translate-x-6')}
        >
          <div className={INNER}>
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink-50">{active.name}</span>
              <Chip>{battleLabel(style, 'type', active.type)}</Chip>
              <span className="font-pixel text-[10px] text-ink-300">Lv {active.level}</span>
            </div>
            <Bar className="mt-1.5" label="HP" kind="hp" value={d.hp[d.active] ?? 0} max={active.stats.hp} tweenMs={tweenMs} reduced={reduced} showNumbers />
            <Bar className="mt-1" label="FOCUS" kind="focus" value={d.focus[d.active] ?? 0} max={active.stats.focus} tweenMs={tweenMs} reduced={reduced} showNumbers />
            {setup.party.length > 1 && (
              <ul aria-label="Bench" className="mt-1.5 flex gap-1">
                {setup.party.map((m, i) => {
                  if (i === d.active) return null;
                  const out = (d.hp[i] ?? 0) <= 0;
                  return (
                    <li
                      key={i}
                      aria-label={out ? `${m.name}, fainted` : `${m.name}, ${d.hp[i] ?? 0} of ${m.stats.hp} HP`}
                      title={m.name}
                      className={cx('inline-flex size-5 items-center justify-center rounded-full text-[9px] font-bold ring-1 transition-colors duration-200', out ? 'bg-ink-800 text-ink-500 ring-ink-700' : 'bg-ink-700 text-ink-100 ring-cozy/50')}
                    >
                      <span aria-hidden="true">{Array.from(m.name)[0]?.toUpperCase() ?? '?'}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {showPanel ? (
        <Panel onHeight={(h) => { setPanelH(h); onInsets?.(h); }} entered={entered}>
          <BattleLog lines={view.lines} current={view.current} reduced={reduced} onSkip={() => view.busy && controller.skip()} />
          <div className="flex w-[40%] min-w-0 shrink-0 flex-col border-l border-ink-600/70 max-sm:w-[46%]">
            <CommandMenu ctx={ctx} style={style} state={shownMenu} busy={view.busy || view.state.phase === 'ended'} onInput={dispatch} idPrefix={idPrefix} />
          </div>
        </Panel>
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-ink-950/40 p-4">
          <ResultsPanel
            setup={setup}
            style={style}
            result={outcome?.result ?? view.result ?? 'timeout'}
            phase={phase}
            outcome={outcome}
            error={error}
            reduced={reduced}
            onContinue={onContinue}
            onOpenHero={onOpenHero}
          />
        </div>
      )}
    </div>
  );
}

/** The full-width bottom box; reports its height (0 when it unmounts). */
function Panel({ children, onHeight, entered }: { children: React.ReactNode; onHeight: (h: number) => void; entered: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onHeight);
  cb.current = onHeight;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => cb.current(Math.round(el.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === 'undefined') return () => cb.current(0);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cb.current(0);
    };
  }, []);
  return (
    <div
      ref={ref}
      className={cx(
        'pointer-events-auto absolute inset-x-0 bottom-0 flex h-44 border-t-2 border-cozy/70 bg-ink-950/95 ring-1 ring-inset ring-ink-600/70 backdrop-blur max-sm:h-[44%]',
        ENTER,
        entered ? 'translate-y-0 opacity-100' : 'opacity-0 motion-safe:translate-y-full',
      )}
    >
      {children}
    </div>
  );
}
