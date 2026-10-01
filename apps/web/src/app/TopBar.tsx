import { useEffect, useMemo, useState } from 'react';
import { ALL_FLOORS, onFloor, useOfficeStore, visibleProjects, type ConnectionState } from '../stores/officeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { enterDemo, startLive } from '../lib/connection';
import { formatTokens } from '../lib/format';
import { sumFloorUsage, totalTokens } from '../lib/tokens';
import { floorNeighbors, floorsInOrder, MULTIVERSE_FLOOR, MULTIVERSE_ICON } from '../lib/floors';
import { officeNavBus } from '../game/OfficeGame';
import { FloorManager } from '../features/office/FloorManager';
import { HeroPanel } from '../features/heroes/HeroPanel';
import { AdminBadge } from '../features/auth/AdminBadge';
import { shouldOpenHelp } from '../features/help/hotkeys';
import { useHelpOverlayStore } from '../features/help/store';
import { HelpOverlay } from '../features/help/HelpOverlay';
import { Button, Select, cx } from '../components/ui';
import { MenuSheet } from './MenuSheet';
import { MENU_HOTKEYS } from './menuHotkeys';
import { useMenuActions } from './useMenuActions';

const CONNECTION: Record<ConnectionState, { label: string; dot: string }> = {
  idle: { label: 'Idle', dot: 'bg-ink-400' },
  connecting: { label: 'Connecting…', dot: 'bg-amber-400 motion-safe:animate-pulse' },
  connected: { label: 'Live', dot: 'bg-emerald-400' },
  disconnected: { label: 'Offline', dot: 'bg-red-500' },
  demo: { label: 'Demo', dot: 'bg-fuchsia-400' },
};

/** The floor picker. Compact: it is the only floor control a phone gets in the bar; "Manage floors" lives in the menu (F). */
function FloorSelect() {
  const projects = useOfficeStore((s) => s.projects);
  const agents = useOfficeStore((s) => s.agents);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const select = useOfficeStore((s) => s.selectProject);
  const list = useMemo(() => visibleProjects(projects, { selectedId: selected }), [projects, selected]);
  const count = (id: string) => Object.values(agents).filter((a) => id === ALL_FLOORS || a.projectId === id).length;
  return (
    <Select aria-label="Floor" className="w-28 min-w-0 sm:w-48" value={selected} onChange={(e) => select(e.target.value)}>
      <option value={ALL_FLOORS}>
        {MULTIVERSE_ICON} {MULTIVERSE_FLOOR.name} ({count(ALL_FLOORS)})
      </option>
      {list.map((p) => (
        <option key={p.id} value={p.id} title={p.cwd}>
          {p.name}
          {p.archived ? ' (archived)' : ''} ({count(p.id)})
        </option>
      ))}
      {selected !== ALL_FLOORS && !projects[selected] && <option value={selected}>{selected}</option>}
    </Select>
  );
}

/**
 * Floor position + up/down buttons mirroring the stairs (docs/design/guild-hall.md section 6): same
 * `floorOrder` neighbor resolution as `OfficeView`'s stairs and PageUp/PageDown, disabled at the
 * ends. The buttons ask for the same animated stairs transition the scene uses (item 7g), via
 * `officeNavBus` — `OfficeView` is the subscriber that actually knows the game instance and the
 * transitioning/modal guards, so the top bar only needs to know which direction was pressed.
 * Hidden on a phone (the menu has the same up/down there).
 */
function FloorIndicator() {
  const projects = useOfficeStore((s) => s.projects);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const floorOrder = useSettingsStore((s) => s.settings.office.floorOrder);
  const order = floorsInOrder(Object.values(projects), floorOrder, selected);
  const n = floorNeighbors(order, selected);
  if (!n) return null;
  return (
    <div className="hidden items-center rounded-full bg-ink-800 px-0.5 sm:flex" role="group" aria-label="Floor navigation">
      <Button variant="ghost" className="px-1.5" disabled={!n.below} onClick={() => officeNavBus.requestFloorNav('down')} aria-label="Floor down" title="Floor down (PageDown)">
        ↓
      </Button>
      <span className="whitespace-nowrap px-0.5 text-[11px] tabular-nums text-ink-300" title={order[n.index]?.name}>
        {n.index + 1} / {n.count}
      </span>
      <Button variant="ghost" className="px-1.5" disabled={!n.above} onClick={() => officeNavBus.requestFloorNav('up')} aria-label="Floor up" title="Floor up (PageUp)">
        ↑
      </Button>
    </div>
  );
}

/** Sum of active sessions' usage on the selected floor. Unobtrusive — hidden until there's something to show, and on narrow bars. */
function FloorUsage() {
  const sessions = useOfficeStore((s) => s.sessions);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const usage = useMemo(() => {
    const active = Object.values(sessions).filter((s) => s.status === 'active' && onFloor(selected, s.projectId));
    // Sessions are independent conversations: input/output/cache/messages add up across them, but
    // contextTokens does not — see sumFloorUsage.
    return sumFloorUsage(active.map((s) => s.usage));
  }, [sessions, selected]);
  if (usage.messages === 0) return null;
  return (
    <span
      className="hidden items-center gap-1 rounded-full bg-ink-800 px-2.5 py-1 text-[11px] text-ink-300 md:flex"
      title={`${formatTokens(usage.contextTokens)} context tokens in the fullest session · ${usage.messages} messages this floor`}
    >
      {formatTokens(totalTokens(usage))} tok
    </span>
  );
}

/** Connection state: a dot on a phone, dot + label from `sm` up. Retry/Demo live in the menu on a phone. */
function ConnectionBadge() {
  const connection = useOfficeStore((s) => s.connection);
  const error = useOfficeStore((s) => s.connectionError);
  const c = CONNECTION[connection];
  return (
    <div className="flex items-center gap-2" role="status">
      <span className="flex items-center gap-1.5 rounded-full bg-ink-800 px-2.5 py-1 text-[11px] text-ink-300" title={error ?? c.label}>
        <span className={cx('size-2 rounded-full', c.dot)} />
        <span className="max-sm:sr-only">{c.label}</span>
      </span>
      {connection === 'disconnected' && (
        <span className="hidden items-center gap-2 md:flex">
          <Button variant="ghost" onClick={startLive}>
            Retry
          </Button>
          <Button variant="primary" onClick={enterDemo} title="Server unreachable — watch a simulated team instead">
            Demo
          </Button>
        </span>
      )}
    </div>
  );
}

/**
 * The `?` hotkey help overlay (M9 8f): lists every hotkey in the app, grouped by area
 * (`features/help/hotkeys.ts`'s `HOTKEY_GROUPS`). `shouldOpenHelp` folds in the same
 * ignored-while-typing / ignored-while-a-modal-is-open guards the menu hotkeys use.
 */
function useHelpHotkey() {
  const openHelp = useHelpOverlayStore((s) => s.openHelp);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!shouldOpenHelp(e)) return;
      e.preventDefault();
      openHelp();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openHelp]);
  return openHelp;
}

/**
 * The compact top bar (M12): logo, floor picker + indicator, status, and ONE Menu button. Every
 * panel and tool (Board, Log, Quests, Roles, Settings, Heroes, Hall Planner, Receptionist, screen
 * effect, alerts, help) lives in `MenuSheet`, each with a hotkey (`menuHotkeys.ts`, registered once by
 * `useMenuActions`). The same actions are the entry point for in-canvas furniture triggers later.
 */
export function TopBar({ onOpenPlanner }: { onOpenPlanner: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const openHelp = useHelpHotkey();
  const actions = useMenuActions({ onOpenPlanner, onManageFloors: () => setManaging(true), onToggleMenu: () => setMenuOpen((v) => !v) });

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-ink-700 bg-ink-900 px-2 pl-[max(0.5rem,env(safe-area-inset-left))] pr-[max(0.5rem,env(safe-area-inset-right))] sm:gap-3 sm:px-4">
        <div className="flex shrink-0 items-center gap-2">
          <span className="grid size-6 place-items-center rounded bg-cozy text-[11px] font-black text-ink-950">tc</span>
          <span className="font-pixel text-sm font-semibold tracking-tight text-ink-100 max-md:sr-only">tagconn</span>
        </div>
        <FloorSelect />
        <FloorIndicator />
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <FloorUsage />
          <AdminBadge />
          <ConnectionBadge />
          <Button variant="subtle" aria-haspopup="dialog" aria-expanded={menuOpen} aria-keyshortcuts={MENU_HOTKEYS.menu} title={`Menu (${MENU_HOTKEYS.menu})`} onClick={() => setMenuOpen((v) => !v)}>
            <span aria-hidden="true">☰</span>
            <span className="max-sm:sr-only">Menu</span>
          </Button>
        </div>
      </header>
      {menuOpen && <MenuSheet actions={actions} onClose={() => setMenuOpen(false)} onHelp={openHelp} />}
      {managing && <FloorManager onClose={() => setManaging(false)} />}
      {/* Mounted here because TopBar is always present and the panel is opened from subtrees that
          share no closer common parent — see `features/heroes/store.ts`. */}
      <HeroPanel />
      <HelpOverlay />
    </>
  );
}
