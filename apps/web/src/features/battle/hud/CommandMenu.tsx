import { useEffect, useRef } from 'react';
import { cx } from '../../../components/ui';
import type { BattleStyle } from '../../../game/battle/types';
import { battleLabel } from '../labels';
import { effectivenessLabel, menuEntries, movePreview, type MenuCtx, type MenuEntry, type MenuInput, type MenuState } from './menuModel';

const ROOT_LABEL = { fight: 'Fight', skill: 'Skill', item: 'Item', swap: 'Swap', run: 'Run' } as const;
const ROOT_ICON = { fight: '⚔', skill: '✦', item: '🎒', swap: '⇄', run: '🏃' } as const;
const TITLE = { root: 'Command', skill: 'Skill', item: 'Item', itemTarget: 'Use on…', swap: 'Swap in' } as const;
const REASON = { focus: 'Not enough FOCUS', empty: 'None left', none: 'Unavailable', ended: 'Battle over' } as const;

interface Row { label: string; detail: string; note: string | null; aria: string }

function describe(e: MenuEntry, ctx: MenuCtx, style: BattleStyle): Row {
  const { setup, battle } = ctx;
  const name = (i: number): string => setup.party[i]?.name ?? 'Member';
  const hp = (i: number): string => `${battle.party[i]?.hp ?? 0}/${setup.party[i]?.stats.hp ?? 0} HP`;
  const why = e.disabled && e.reason ? REASON[e.reason] : null;
  let label = '';
  let detail = '';
  let note: string | null = why;
  switch (e.kind) {
    case 'fight': case 'skill': case 'item': case 'swap': case 'run':
      label = ROOT_LABEL[e.kind];
      break;
    case 'move': {
      const mv = setup.party[battle.active]?.moves[e.index ?? 0];
      label = mv ? battleLabel(style, 'move', mv.id) : 'Move';
      detail = mv ? `${mv.focusCost} FP` : '';
      if (!why && mv) {
        const p = movePreview(ctx, e.index ?? 0);
        note = [battleLabel(style, 'type', mv.type), p ? effectivenessLabel(p.eff) : null].filter(Boolean).join(' · ');
      }
      break;
    }
    case 'useItem': {
      const it = setup.items[e.index ?? 0];
      label = it ? battleLabel(style, 'item', it.def.id) : 'Item';
      detail = `×${battle.items[e.index ?? 0] ?? 0}`;
      break;
    }
    case 'target':
      label = name(e.index ?? 0);
      detail = hp(e.index ?? 0);
      break;
    case 'swapTo':
      label = name(e.index ?? 0);
      detail = `Lv ${setup.party[e.index ?? 0]?.level ?? 1} · ${hp(e.index ?? 0)}`;
      break;
    case 'back':
      label = 'Back';
      note = e.disabled ? 'Choose a replacement' : null;
      break;
  }
  const aria = [label, detail, note].filter(Boolean).join(', ');
  return { label, detail, note, aria };
}

/**
 * Fight / Skill / Item / Swap / Run and their sub-lists. One focusable `menu` owns the keyboard (the HUD routes keys to
 * it) and points at the highlighted row with `aria-activedescendant`; rows are mouse targets. Sounds are played by the
 * caller from the reducer result, so rows carry `data-sfx="none"` to keep the delegated click sound out.
 */
export function CommandMenu({ ctx, style, state, busy, onInput, idPrefix }: { ctx: MenuCtx; style: BattleStyle; state: MenuState; busy: boolean; onInput: (i: MenuInput) => void; idPrefix: string }) {
  const entries = menuEntries(state, ctx);
  const root = state.screen === 'root';
  const menuRef = useRef<HTMLDivElement>(null);
  const rowId = (i: number): string => `${idPrefix}-row-${i}`;

  // Keep the highlighted row visible in long lists.
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>(`[id="${rowId(state.cursor)}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [state.cursor, state.screen]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 p-2">
      <p className="flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-widest text-cozy/90">
        <span>{TITLE[state.screen]}</span>
        {busy && <span className="font-normal normal-case tracking-normal text-ink-400">Enter to skip</span>}
      </p>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Battle commands"
        aria-orientation={root ? undefined : 'vertical'}
        aria-activedescendant={rowId(state.cursor)}
        aria-busy={busy}
        tabIndex={0}
        className={cx(
          'min-h-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-cozy/70',
          root ? 'grid grid-cols-2 content-start gap-1.5 max-sm:grid-cols-3' : 'flex flex-col gap-1 overflow-y-auto',
          busy && 'opacity-60',
        )}
      >
        {entries.map((e, i) => {
          const row = describe(e, ctx, style);
          const selected = i === state.cursor;
          return (
            <div
              key={`${state.screen}-${e.kind}-${e.index ?? ''}`}
              id={rowId(i)}
              role="menuitem"
              aria-label={row.aria}
              aria-disabled={e.disabled || undefined}
              data-sfx="none"
              data-selected={selected || undefined}
              onPointerEnter={(ev) => ev.pointerType === 'mouse' && onInput({ t: 'hover', index: i })}
              onClick={() => onInput({ t: 'click', index: i })}
              className={cx(
                'flex min-h-9 cursor-pointer select-none items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors duration-100 coarse:min-h-11',
                // Phones: a 3-column grid of icon-over-label tiles, so every label stays whole (Skill vs Swap).
                root && 'max-sm:min-h-12 max-sm:flex-col max-sm:justify-center max-sm:gap-0.5 max-sm:px-1',
                root && e.kind === 'run' && 'col-span-2 max-sm:col-span-1',
                selected ? 'border-cozy/80 bg-cozy/15 text-ink-50' : 'border-ink-600/70 bg-ink-800/80 text-ink-200',
                e.disabled && 'text-ink-500',
                root && e.kind === 'back' && 'hidden',
              )}
            >
              <span aria-hidden="true" className={cx('w-3 shrink-0 text-center text-[10px] text-cozy', !selected && 'invisible', root && 'max-sm:hidden')}>▶</span>
              {root && <span aria-hidden="true" className="w-4 shrink-0 text-center">{ROOT_ICON[e.kind as keyof typeof ROOT_ICON]}</span>}
              <span className={cx('min-w-0 flex-1 truncate font-semibold', root && 'max-sm:flex-none max-sm:text-[11px]')}>{row.label}</span>
              {row.note && <span className="hidden min-w-0 shrink truncate text-[10px] text-ink-400 sm:inline">{row.note}</span>}
              {row.detail && <span className="shrink-0 font-pixel text-[10px] tabular-nums text-ink-300">{row.detail}</span>}
              {!root && <span aria-hidden="true" className="hidden w-3 text-right text-[9px] text-ink-500 sm:inline">{i + 1 <= 9 ? i + 1 : ''}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
