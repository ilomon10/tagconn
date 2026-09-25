import { useEffect, useMemo, useState } from 'react';
import { ALL_FLOORS, onFloor, useOfficeStore, visibleProjects, type ConnectionState } from '../stores/officeStore';
import { useSettingsStore } from '../stores/settingsStore';
import { enterDemo, exitDemo, startLive } from '../lib/connection';
import { notificationsSupported, requestNotificationPermission } from '../lib/notify';
import { formatTokens } from '../lib/format';
import { sumFloorUsage, totalTokens } from '../lib/tokens';
import { floorNeighbors, floorsInOrder, isModalOpen, isTypingTarget } from '../lib/floors';
import { officeNavBus } from '../game/OfficeGame';
import { FloorManager } from '../features/office/FloorManager';
import { HeroPanel } from '../features/heroes/HeroPanel';
import { defaultHeroFloor } from '../features/heroes/formState';
import { useHeroPanelStore } from '../features/heroes/store';
import { Button, Select, cx } from '../components/ui';

export type Tab = 'office' | 'board' | 'log' | 'roles' | 'settings';
export const TABS: { id: Tab; label: string }[] = [
  { id: 'office', label: 'Office' },
  { id: 'board', label: 'Board' },
  { id: 'log', label: 'Log' },
  { id: 'roles', label: 'Roles' },
  { id: 'settings', label: 'Settings' },
];

const CONNECTION: Record<ConnectionState, { label: string; dot: string }> = {
  idle: { label: 'Idle', dot: 'bg-ink-400' },
  connecting: { label: 'Connecting…', dot: 'bg-amber-400 animate-pulse' },
  connected: { label: 'Live', dot: 'bg-emerald-400' },
  disconnected: { label: 'Offline', dot: 'bg-red-500' },
  demo: { label: 'Demo', dot: 'bg-fuchsia-400' },
};

function FloorSelect() {
  const projects = useOfficeStore((s) => s.projects);
  const agents = useOfficeStore((s) => s.agents);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const select = useOfficeStore((s) => s.selectProject);
  const [managing, setManaging] = useState(false);
  const list = useMemo(() => visibleProjects(projects, { selectedId: selected }), [projects, selected]);
  const count = (id: string) => Object.values(agents).filter((a) => id === ALL_FLOORS || a.projectId === id).length;
  return (
    <div className="flex items-center gap-1.5">
      <Select aria-label="Floor" className="w-56" value={selected} onChange={(e) => select(e.target.value)}>
        <option value={ALL_FLOORS}>All floors ({count(ALL_FLOORS)})</option>
        {list.map((p) => (
          <option key={p.id} value={p.id} title={p.cwd}>
            {p.name}
            {p.archived ? ' (archived)' : ''} ({count(p.id)})
          </option>
        ))}
        {selected !== ALL_FLOORS && !projects[selected] && <option value={selected}>{selected}</option>}
      </Select>
      <Button variant="ghost" title="Rename or archive floors" onClick={() => setManaging(true)}>
        Manage
      </Button>
      {managing && <FloorManager onClose={() => setManaging(false)} />}
    </div>
  );
}

/**
 * Floor position + up/down buttons mirroring the stairs (docs/design/guild-hall.md section 6): same
 * `floorOrder` neighbor resolution as `OfficeView`'s stairs and PageUp/PageDown, disabled at the
 * ends. The buttons ask for the same animated stairs transition the scene uses (item 7g), via
 * `officeNavBus` — `OfficeView` is the subscriber that actually knows the game instance and the
 * transitioning/modal guards, so the top bar only needs to know which direction was pressed.
 */
function FloorIndicator() {
  const projects = useOfficeStore((s) => s.projects);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const floorOrder = useSettingsStore((s) => s.settings.office.floorOrder);
  if (selected === ALL_FLOORS) {
    return <span className="rounded-full bg-ink-800 px-2.5 py-1 text-[11px] text-ink-400">All floors</span>;
  }
  const order = floorsInOrder(Object.values(projects), floorOrder, selected);
  const n = floorNeighbors(order, selected);
  if (!n) return null;
  const current = order[n.index]!;
  return (
    <div className="flex items-center gap-1 rounded-full bg-ink-800 px-1.5 py-1">
      <Button variant="ghost" className="px-1.5" disabled={!n.below} onClick={() => officeNavBus.requestFloorNav('down')} aria-label="Floor down" title="Floor down (PageDown)">
        ↓
      </Button>
      <span className="whitespace-nowrap px-1 text-[11px] text-ink-400">
        Floor {n.index + 1} / {n.count} — {current.name}
      </span>
      <Button variant="ghost" className="px-1.5" disabled={!n.above} onClick={() => officeNavBus.requestFloorNav('up')} aria-label="Floor up" title="Floor up (PageUp)">
        ↑
      </Button>
    </div>
  );
}

/** Sum of active sessions' usage on the selected floor. Unobtrusive — hidden until there's something to show. */
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
      className="hidden items-center gap-1 rounded-full bg-ink-800 px-2.5 py-1 text-[11px] text-ink-400 sm:flex"
      title={`${formatTokens(usage.contextTokens)} context tokens in the fullest session · ${usage.messages} messages this floor`}
    >
      {formatTokens(totalTokens(usage))} tok
    </span>
  );
}

function ConnectionBadge() {
  const connection = useOfficeStore((s) => s.connection);
  const error = useOfficeStore((s) => s.connectionError);
  const c = CONNECTION[connection];
  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 rounded-full bg-ink-800 px-2.5 py-1 text-[11px] text-ink-300" title={error}>
        <span className={cx('size-2 rounded-full', c.dot)} />
        {c.label}
      </span>
      {connection === 'disconnected' && (
        <>
          <Button variant="ghost" onClick={startLive}>
            Retry
          </Button>
          <Button variant="primary" onClick={enterDemo} title="Server unreachable — watch a simulated team instead">
            Demo
          </Button>
        </>
      )}
      {connection === 'demo' && (
        <Button variant="ghost" onClick={exitDemo}>
          Exit demo
        </Button>
      )}
    </div>
  );
}

/**
 * Opens the Heroes editor (docs/design/living-office.md section 3.4) on the current floor, or the
 * first floor in stairs order for the Multiverse. The `H` hotkey mirrors the same guards every other
 * floor hotkey uses (`lib/floors.ts`): ignored while typing, and while any modal — including the
 * Heroes panel itself — is already open.
 */
function HeroesButton() {
  const projects = useOfficeStore((s) => s.projects);
  const selected = useOfficeStore((s) => s.selectedProjectId);
  const floorOrder = useSettingsStore((s) => s.settings.office.floorOrder);
  const openHeroes = useHeroPanelStore((s) => s.openHeroes);

  const open = () => {
    const floor = defaultHeroFloor(projects, selected, floorOrder);
    if (floor) openHeroes(floor);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'h' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target) || isModalOpen()) return;
      open();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, selected, floorOrder]);

  return (
    <Button variant="ghost" onClick={open} disabled={!defaultHeroFloor(projects, selected, floorOrder)} title="Named characters for this floor (H)">
      Heroes
    </Button>
  );
}

function NotifyButton() {
  const [perm, setPerm] = useState(() => (notificationsSupported() ? Notification.permission : 'denied'));
  if (!notificationsSupported() || perm !== 'default') return null;
  return (
    <Button
      variant="ghost"
      title="Allow browser notifications when agents wait, block or finish"
      onClick={async () => {
        const p = await requestNotificationPermission();
        if (p !== 'unsupported') setPerm(p);
      }}
    >
      Enable alerts
    </Button>
  );
}

export function TopBar({ tab, onTab, onOpenPlanner }: { tab: Tab; onTab: (t: Tab) => void; onOpenPlanner: () => void }) {
  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-ink-700 bg-ink-900 px-4">
        <div className="flex items-center gap-2">
          <span className="grid size-6 place-items-center rounded bg-cozy text-[11px] font-black text-ink-950">tc</span>
          <span className="font-pixel text-sm font-semibold tracking-tight text-ink-100">tagconn</span>
        </div>
        <FloorSelect />
        <FloorIndicator />
        <nav className="flex items-center gap-0.5 rounded-lg bg-ink-850 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTab(t.id)}
              className={cx(
                'rounded-md px-3 py-1 text-xs transition',
                tab === t.id ? 'bg-ink-600 text-ink-100 shadow' : 'text-ink-400 hover:text-ink-100',
              )}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <HeroesButton />
        <Button variant="ghost" onClick={onOpenPlanner} title="Draw and edit floor plans">
          Hall Planner
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <FloorUsage />
          <NotifyButton />
          <ConnectionBadge />
        </div>
      </header>
      {/* Mounted here (rather than App.tsx) because TopBar is always present regardless of the active
          tab, and the panel is opened from three subtrees that share no closer common parent — see
          `features/heroes/store.ts`. */}
      <HeroPanel />
    </>
  );
}
