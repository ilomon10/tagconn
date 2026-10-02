import { useRef, useState, type ReactNode } from 'react';
import { SCREEN_EFFECT_PREFS, type ScreenEffectPref } from '../stores/displayPrefsStore';
import { useOfficeStore } from '../stores/officeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { enterDemo, exitDemo, startLive } from '../lib/connection';
import { notificationsSupported, requestNotificationPermission } from '../lib/notify';
import { floorNeighbors, floorsInOrder } from '../lib/floors';
import { useModalFocus } from '../lib/useModalFocus';
import { officeNavBus } from '../game/OfficeGame';
import { cx } from '../components/ui';
import { MENU_HOTKEYS, type MenuActionId } from './menuHotkeys';
import { useLightingPrefs } from '../features/office/useLightingPrefs';
import { sfxBus } from '../game/sfxBus';
import { SoundRow } from '../features/office/audio/SoundRow';
import { useScreenEffect, type useMenuActions } from './useMenuActions';

const SCREEN_EFFECT_LABEL: Record<ScreenEffectPref, string> = { crt: 'CRT', lcd: 'LCD', vhs: 'VHS' };

const ROW = 'flex min-h-10 coarse:min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left transition hover:bg-ink-700 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent';

function Keycap({ children }: { children: ReactNode }) {
  return <kbd className="grid h-6 min-w-6 place-items-center rounded border border-ink-600 border-b-2 bg-ink-800 px-1.5 font-pixel text-[10px] text-ink-300 coarse:hidden">{children}</kbd>;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-1.5 py-1.5">
      <h2 className="px-2.5 pb-0.5 pt-1 text-[11px] font-medium text-ink-400">{title}</h2>
      {children}
    </section>
  );
}

function Row({ id, label, hint, actions, onPick }: { id: MenuActionId; label: string; hint: string; actions: ReturnType<typeof useMenuActions>; onPick: () => void }) {
  const a = actions[id];
  return (
    <button
      type="button"
      className={ROW}
      data-sfx-hover
      disabled={a.disabled}
      aria-keyshortcuts={MENU_HOTKEYS[id]}
      onClick={() => {
        onPick();
        a.run();
      }}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink-100">{label}</span>
        <span className="block truncate text-[11px] text-ink-400">{hint}</span>
      </span>
      <Keycap>{MENU_HOTKEYS[id]}</Keycap>
    </button>
  );
}

/** Screen effect: the toggle row plus its CRT/LCD/VHS choice, inline instead of a nested popover. */
function ScreenEffectRow() {
  const fx = useScreenEffect();
  return (
    <div className="rounded-lg px-2.5 py-1.5">
      <div className="flex min-h-11 items-center gap-3 coarse:min-h-0">
        <button
          type="button"
          role="switch"
          aria-checked={fx.on}
          aria-keyshortcuts={MENU_HOTKEYS.screen}
          disabled={fx.disabled}
          onClick={fx.toggle}
          className="flex min-h-11 flex-1 items-center gap-3 text-left disabled:cursor-not-allowed disabled:opacity-40"
          title={fx.disabled ? 'Screen effect unavailable: office.shaders.enabled is off' : undefined}
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink-100">Screen effect</span>
            <span className="block truncate text-[11px] text-ink-400">{fx.disabled ? 'Turned off in settings' : fx.on ? `${SCREEN_EFFECT_LABEL[fx.effect]} monitors on` : 'Monitors plain'}</span>
          </span>
          <span className={cx('relative h-5 w-9 shrink-0 rounded-full transition-colors', fx.on ? 'bg-cozy' : 'bg-ink-600')} aria-hidden="true">
            <span className={cx('absolute left-0.5 top-0.5 size-4 rounded-full bg-ink-100 transition-transform', fx.on && 'translate-x-4')} />
          </span>
        </button>
        <Keycap>{MENU_HOTKEYS.screen}</Keycap>
      </div>
      {!fx.disabled && (
        <div role="radiogroup" aria-label="Screen effect style" className="mt-1 flex gap-1">
          {SCREEN_EFFECT_PREFS.map((effect) => (
            <button
              key={effect}
              type="button"
              role="radio"
              aria-checked={fx.effect === effect}
              onClick={() => fx.setEffect(effect)}
              className={cx(
                'min-h-8 flex-1 rounded-md border text-xs transition coarse:min-h-11',
                fx.effect === effect ? 'border-cozy/60 bg-ink-700 text-cozy' : 'border-ink-700 text-ink-300 hover:bg-ink-700',
              )}
            >
              {SCREEN_EFFECT_LABEL[effect]}
            </button>
          ))}
          <button type="button" onClick={fx.reset} className="min-h-8 rounded-md px-2 text-[11px] text-ink-400 hover:text-ink-100 coarse:min-h-11" title="Use the server's default effect">
            Default
          </button>
        </div>
      )}
    </div>
  );
}

/** Time of day (M16): follow the office clock, or pin this browser's sun to an hour. */
function TimeOfDayRow() {
  const t = useLightingPrefs();
  const click = (): void => sfxBus.emit({ id: 'ui-click' });
  return (
    <div className="rounded-lg px-2.5 py-1.5">
      <div className="flex min-h-11 items-center gap-3 coarse:min-h-0">
        <button
          type="button"
          role="switch"
          aria-checked={t.following}
          onClick={() => {
            if (t.following) t.now();
            else t.follow();
            click();
          }}
          className="flex min-h-11 flex-1 items-center gap-3 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink-100">Time of day</span>
            <span className="block truncate text-[11px] text-ink-400">
              {t.following ? 'Following the office clock' : `${t.label}, ${t.phase}`}
              {t.zone ? ` · ${t.zone}` : ''}
            </span>
          </span>
          <span className={cx('relative h-5 w-9 shrink-0 rounded-full transition-colors', t.following ? 'bg-cozy' : 'bg-ink-600')} aria-hidden="true">
            <span className={cx('absolute left-0.5 top-0.5 size-4 rounded-full bg-ink-100 transition-transform', t.following && 'translate-x-4')} />
          </span>
        </button>
      </div>
      {!t.following && (
        <div className="mt-1 flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={24}
            step={0.25}
            value={t.hour}
            aria-label="Time of day"
            aria-valuetext={`${t.label}, ${t.phase}`}
            onChange={(e) => t.setHour(Number(e.target.value))}
            onPointerUp={click}
            className="min-h-8 flex-1 accent-cozy coarse:min-h-11"
          />
          <span className="w-12 shrink-0 text-right font-pixel text-[10px] text-ink-300">{t.label}</span>
          <button
            type="button"
            onClick={() => {
              t.now();
              click();
            }}
            className="min-h-8 rounded-md px-2 text-[11px] text-ink-400 hover:text-ink-100 coarse:min-h-11"
            title="Jump to the office's current hour"
          >
            Now
          </button>
          <button
            type="button"
            onClick={() => {
              t.follow();
              click();
            }}
            className="min-h-8 rounded-md px-2 text-[11px] text-ink-400 hover:text-ink-100 coarse:min-h-11"
            title="Follow the office clock again"
          >
            Default
          </button>
        </div>
      )}
    </div>
  );
}

/** Floor up/down for narrow screens, where the top bar has no room for the floor indicator. */
function FloorRow({ onPick }: { onPick: () => void }) {
  const projects = useOfficeStore((s) => s.projects);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const floorOrder = useSettingsStore((s) => s.settings.office.floorOrder);
  const n = floorNeighbors(floorsInOrder(Object.values(projects), floorOrder, selected), selected);
  if (!n) return null;
  const go = (dir: 'up' | 'down') => {
    onPick();
    officeNavBus.requestFloorNav(dir);
  };
  return (
    <div className="flex items-center gap-3 px-2.5 py-1.5 sm:hidden">
      <span className="min-w-0 flex-1 text-sm font-medium text-ink-100">
        Floor {n.index + 1} of {n.count}
      </span>
      <button type="button" className="grid min-h-11 min-w-11 place-items-center rounded-lg bg-ink-800 text-ink-100 disabled:opacity-40" disabled={!n.below} onClick={() => go('down')} aria-label="Floor down">
        ↓
      </button>
      <button type="button" className="grid min-h-11 min-w-11 place-items-center rounded-lg bg-ink-800 text-ink-100 disabled:opacity-40" disabled={!n.above} onClick={() => go('up')} aria-label="Floor up">
        ↑
      </button>
    </div>
  );
}

/**
 * The top bar's one menu (M12): a game-style list of every panel and tool, each with its hotkey.
 * Opened by the Menu button or `M`. A popover under the top bar on desktop, nearly full width on a
 * phone. It is a modal (`data-modal`) so floor/roster hotkeys stay quiet while it is open; picking a
 * row closes it first, then runs the action, so the opened panel owns focus and Esc.
 */
export function MenuSheet({ actions, onClose, onHelp }: { actions: ReturnType<typeof useMenuActions>; onClose: () => void; onHelp: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(true, ref, { trap: true, onEscape: onClose });
  const connection = useOfficeStore((s) => s.connection);
  const [perm, setPerm] = useState(() => (notificationsSupported() ? Notification.permission : 'denied'));
  const pick = { actions, onPick: onClose };

  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Menu" data-modal="menu" className="anim-fade fixed inset-0 z-40 bg-black/35" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="anim-menu absolute inset-x-2 top-[3.25rem] flex max-h-[calc(100dvh-3.75rem)] flex-col overflow-y-auto rounded-xl border border-ink-700 bg-ink-850 p-1 shadow-2xl sm:inset-x-auto sm:right-2 sm:w-[22rem] side:w-[22rem] side:max-h-[calc(100dvh-3.5rem)]">
        <Group title="Panels">
          <Row id="board" label="Board" hint="Tasks by status" {...pick} />
          <Row id="log" label="Log" hint="Every hook event as it arrives" {...pick} />
          <Row id="quests" label="Quests" hint="Run Claude from the browser" {...pick} />
          <Row id="roles" label="Roles" hint="Titles, colors and prompts" {...pick} />
          <Row id="settings" label="Settings" hint="Office, agents, runner" {...pick} />
        </Group>
        <Group title="Office">
          <Row id="heroes" label="Heroes" hint="Named characters for this floor" {...pick} />
          <Row id="planner" label="Hall Planner" hint="Draw and edit floor plans" {...pick} />
          <Row id="receptionist" label="Receptionist" hint="A read-only help desk" {...pick} />
          <Row id="floors" label="Manage floors" hint="Rename or archive floors" {...pick} />
          <FloorRow onPick={onClose} />
        </Group>
        <Group title="This browser">
          <ScreenEffectRow />
          <TimeOfDayRow />
          <SoundRow />
          {notificationsSupported() && perm === 'default' && (
            <button
              type="button"
              className={ROW}
              onClick={async () => {
                const p = await requestNotificationPermission();
                if (p !== 'unsupported') setPerm(p);
              }}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-ink-100">Enable alerts</span>
                <span className="block truncate text-[11px] text-ink-400">Notify when agents wait, block or finish</span>
              </span>
            </button>
          )}
          {connection === 'disconnected' && (
            <>
              <button type="button" className={ROW} onClick={() => (onClose(), startLive())}>
                <span className="text-sm font-medium text-ink-100">Retry connection</span>
              </button>
              <button type="button" className={ROW} onClick={() => (onClose(), enterDemo())}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink-100">Watch the demo</span>
                  <span className="block truncate text-[11px] text-ink-400">The server is unreachable; see a simulated team</span>
                </span>
              </button>
            </>
          )}
          {connection === 'demo' && (
            <button type="button" className={ROW} onClick={() => (onClose(), exitDemo())}>
              <span className="text-sm font-medium text-ink-100">Exit demo</span>
            </button>
          )}
          <button
            type="button"
            className={ROW}
            onClick={() => {
              onClose();
              onHelp();
            }}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink-100">Keyboard shortcuts</span>
              <span className="block truncate text-[11px] text-ink-400">Help</span>
            </span>
            <Keycap>?</Keycap>
          </button>
        </Group>
      </div>
    </div>
  );
}
