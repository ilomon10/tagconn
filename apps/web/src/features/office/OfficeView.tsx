import { useEffect, useRef, useState } from 'react';
import { MULTIVERSE_THEME_ID, type Agent, type MultiverseProjectInput, type Project, type Settings, type OfficeLayout } from '@tagconn/shared';
import { OfficeGame, officeNavBus, type FloorNavDirection, type OfficeState } from '../../game/OfficeGame';
import { getTheme } from '../../game/themes';
import { planMultiverse } from '../../game/multiverse/plan';
import { onFloor, useOfficeStore } from '../../stores/officeStore';
import { useHeroStore } from '../../stores/heroStore';
import { useHeroPanelStore } from '../heroes/store';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFloorAgents } from '../../lib/hooks';
import { firstFloor, floorNeighbors, floorsInOrder, isModalOpen, isMultiverseFloor, isTypingTarget, neighborFloor, topProjectFloor } from '../../lib/floors';
import { layoutForProject, useLayoutStore } from '../../stores/layoutStore';
import { ZERO_INSETS, insetsFromOverlay } from '../../game/camera/insets';
import { Roster } from './Roster';
import { AgentDrawer } from './AgentDrawer';
import { FloorManager } from './FloorManager';
import { GmSessionsPopover } from './GmSessionsPopover';
import { Button } from '../../components/ui';

/**
 * Per-project inputs `planMultiverse` needs (docs/design/living-office.md section 6.1), built from
 * the stores W7b owns: `officeStore`'s `lastLiveAt` hysteresis (M8 8h) plus each project's resolved
 * layout style. Archived projects never get a realm.
 */
function multiverseProjectInputs(
  projects: Record<string, Project>,
  agents: Record<string, Agent>,
  lastLiveAt: Record<string, number>,
  layouts: Record<string, OfficeLayout>,
  settings: Settings,
): MultiverseProjectInput[] {
  const liveAgents = new Map<string, number>();
  for (const a of Object.values(agents)) if (a.status !== 'done') liveAgents.set(a.projectId, (liveAgents.get(a.projectId) ?? 0) + 1);
  return Object.values(projects)
    .filter((p) => !p.archived)
    .map((p) => {
      const layout = layoutForProject(layouts, p, settings.office.defaultLayoutId);
      return {
        id: p.id,
        name: p.name,
        style: layout.style ?? settings.office.style,
        createdAt: p.createdAt,
        lastActivityAt: p.lastActivityAt,
        liveAgents: liveAgents.get(p.id) ?? 0,
        lastLiveAt: lastLiveAt[p.id] ?? 0,
      };
    });
}

/** Pushes store changes into the Phaser scene (the "bridge"). On the Multiverse floor this builds
 *  the generated Nexus layout from `planMultiverse` (M8 8h) instead of a stored project layout. */
function useGameBridge(game: OfficeGame | null) {
  useEffect(() => {
    if (!game) return;
    const push = () => {
      const { agents, projects, sessions, selectedProjectId, lastLiveAt, pinnedPrimary } = useOfficeStore.getState();
      const { settings, roles } = useSettingsStore.getState();
      const layouts = useLayoutStore.getState().layouts;
      const heroes = Object.values(useHeroStore.getState().heroes);
      const floorAgents = Object.values(agents).filter((a) => onFloor(selectedProjectId, a.projectId));

      const atMultiverse = isMultiverseFloor(selectedProjectId);
      let layout = layoutForProject(layouts, atMultiverse ? undefined : projects[selectedProjectId], settings.office.defaultLayoutId);
      let style: OfficeState['style'] = layout.style ?? settings.office.style;
      let multiverse: OfficeState['multiverse'] = null;
      if (atMultiverse) {
        const inputs = multiverseProjectInputs(projects, agents, lastLiveAt, layouts, settings);
        multiverse = planMultiverse(inputs, {
          maxRealms: settings.office.multiverseMaxRealms,
          floorOrder: settings.office.floorOrder,
          now: Date.now(),
          idleLeaveSec: settings.office.idleLeaveSec,
        });
        layout = multiverse.layout;
        style = MULTIVERSE_THEME_ID;
      }

      let floor: OfficeState['floor'] = null;
      const order = floorsInOrder(Object.values(projects), settings.office.floorOrder, selectedProjectId);
      const n = floorNeighbors(order, selectedProjectId);
      if (n) {
        floor = {
          index: n.index,
          count: n.count,
          above: n.above && { id: n.above.id, label: floorLabelForEntry(n.above, n.index + 1, layouts, settings) },
          below: n.below && { id: n.below.id, label: floorLabelForEntry(n.below, n.index - 1, layouts, settings) },
        };
      }

      game.setState({
        agents: floorAgents,
        settings,
        roles,
        floorKey: selectedProjectId,
        layout,
        style,
        floor,
        heroes,
        sessions: Object.values(sessions).filter((s) => onFloor(selectedProjectId, s.projectId)),
        multiverse,
        pinnedPrimary,
      });
    };
    push();
    const unsubOffice = useOfficeStore.subscribe((s, p) => {
      if (
        s.agents !== p.agents ||
        s.sessions !== p.sessions ||
        s.selectedProjectId !== p.selectedProjectId ||
        s.projects !== p.projects ||
        s.lastLiveAt !== p.lastLiveAt ||
        s.pinnedPrimary !== p.pinnedPrimary
      )
        push();
    });
    const unsubSettings = useSettingsStore.subscribe((s, p) => {
      if (s.settings !== p.settings || s.roles !== p.roles) push();
    });
    const unsubLayouts = useLayoutStore.subscribe((s, p) => {
      if (s.layouts !== p.layouts) push();
    });
    const unsubHeroes = useHeroStore.subscribe((s, p) => {
      if (s.heroes !== p.heroes) push();
    });
    return () => {
      unsubOffice();
      unsubSettings();
      unsubLayouts();
      unsubHeroes();
    };
  }, [game]);
}

/** The floor's display label ("Floor 2 · tagconn"), themed per that floor's own style. */
function floorLabelFor(project: Project, index: number, layouts: Record<string, OfficeLayout>, settings: Settings): string {
  const layout = layoutForProject(layouts, project, settings.office.defaultLayoutId);
  return getTheme(layout.style ?? settings.office.style).floorLabel(index, project.name);
}

/** Like `floorLabelFor`, but handles the synthetic Multiverse entry (no real layout/style of its
 *  own — it's always labelled with the rift theme's "The Multiverse", regardless of neighbor index). */
function floorLabelForEntry(entry: Project, index: number, layouts: Record<string, OfficeLayout>, settings: Settings): string {
  if (isMultiverseFloor(entry.id)) return getTheme(MULTIVERSE_THEME_ID).floorLabel(index, entry.name);
  return floorLabelFor(entry, index, layouts, settings);
}

/**
 * True when a floor change may proceed: not already mid-transition (bug: re-entrancy would stack
 * fades), and the Hall Planner editor (or any other full-screen modal) isn't covering the screen
 * (bug: PageUp/PageDown/Home/End/F and stairs clicks used to fire underneath it).
 */
function canNavigateFloors(game: OfficeGame | null): boolean {
  return !isModalOpen() && !game?.isTransitioning;
}

/** Runs the stairs transition (fade via the scene), then re-selects the floor and toasts its label. */
async function goToFloor(game: OfficeGame | null, target: Project, ms: number, layouts: Record<string, OfficeLayout>, settings: Settings, showToast: (s: string) => void, dir?: FloorNavDirection) {
  const order = floorsInOrder(Object.values(useOfficeStore.getState().projects), settings.office.floorOrder);
  const index = order.findIndex((p) => p.id === target.id);
  const label = floorLabelForEntry(target, index, layouts, settings);
  const select = () => useOfficeStore.getState().selectProject(target.id);
  if (game) await game.transitionFloor(ms, select, dir);
  else select();
  showToast(label);
}

export function OfficeView({ active }: { active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drawer = useRef<HTMLElement | null>(null);
  const [game, setGame] = useState<OfficeGame | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [gmSessionsProjectId, setGmSessionsProjectId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const agents = useFloorAgents();
  const maxCharacters = useSettingsStore((s) => s.settings.office.maxCharacters);
  const connection = useOfficeStore((s) => s.connection);
  const overflow = Math.max(0, agents.length - maxCharacters);

  const closePanel = () => {
    setSelected(null);
    setFollow(false);
  };

  const showToast = (label: string) => {
    setToast(label);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1500);
  };

  useEffect(() => {
    if (!host.current) return;
    const g = new OfficeGame(host.current);
    const offClick = g.on('agentClick', (id) => {
      setSelected(id);
      setFollow(false);
      g.focus(id);
    });
    const offEmpty = g.on('emptyClick', () => closePanel());
    const offFollow = g.on('followChanged', (id) => {
      if (id === null) setFollow(false);
    });
    setGame(g);
    return () => {
      offClick();
      offEmpty();
      offFollow();
      g.destroy();
      setGame(null);
      clearTimeout(toastTimer.current);
    };
  }, []);

  useGameBridge(game);

  // Stairs (docs/design/guild-hall.md section 6; M8 8h living-office.md section 6.3): take the
  // neighboring floor in `office.floorOrder`, or do nothing at an end. The Multiverse is just
  // another floor in that order now (appended last by `floorsInOrder`) — its *up* has no neighbor
  // (disabled) and its *down* always resolves to the top project floor, with zero special-casing.
  useEffect(() => {
    if (!game) return;
    return game.on('stairs', (dir) => {
      if (!canNavigateFloors(game)) return;
      const { projects, selectedProjectId } = useOfficeStore.getState();
      const { settings } = useSettingsStore.getState();
      const layouts = useLayoutStore.getState().layouts;
      const order = floorsInOrder(Object.values(projects), settings.office.floorOrder, selectedProjectId);
      const target = neighborFloor(order, selectedProjectId, dir);
      if (!target) return;
      void goToFloor(game, target, settings.office.floorTransitionMs, layouts, settings, showToast, dir);
    });
  }, [game]);

  // The top bar's floor up/down buttons (docs/design/guild-hall.md section 6, item 7g): the same
  // animated transition as the stairs, reached through a small command bus so `TopBar` doesn't need
  // the game instance — this effect is its one subscriber, sharing the guards below.
  useEffect(() => {
    return officeNavBus.onFloorNavRequest((dir) => {
      if (!canNavigateFloors(game)) return;
      const { projects, selectedProjectId } = useOfficeStore.getState();
      const { settings } = useSettingsStore.getState();
      const layouts = useLayoutStore.getState().layouts;
      const order = floorsInOrder(Object.values(projects), settings.office.floorOrder, selectedProjectId);
      const target = neighborFloor(order, selectedProjectId, dir);
      if (!target) return;
      void goToFloor(game, target, settings.office.floorTransitionMs, layouts, settings, showToast, dir);
    });
  }, [game]);

  // Global hotkeys (ignored while typing, with a modifier held so Ctrl+F/Cmd+F still finds text,
  // mid-transition, or while a modal — the Hall Planner editor — covers the screen). PageUp from the
  // top floor reaches the Multiverse (it's the last entry in `order`); PageDown from the Multiverse
  // returns to the top floor. End always goes to the top *project* floor, never the Multiverse
  // (design section 6.3) — that's what `topProjectFloor` is for, unlike `lastFloor`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (!['PageUp', 'PageDown', 'Home', 'End', 'f', 'F'].includes(e.key)) return;
      if (!canNavigateFloors(game)) return;
      const { projects, selectedProjectId } = useOfficeStore.getState();
      const { settings } = useSettingsStore.getState();
      const layouts = useLayoutStore.getState().layouts;
      const order = floorsInOrder(Object.values(projects), settings.office.floorOrder, selectedProjectId);
      const go = (target: Project | undefined, dir?: FloorNavDirection) => {
        if (!target) return;
        e.preventDefault();
        void goToFloor(game, target, settings.office.floorTransitionMs, layouts, settings, showToast, dir);
      };
      switch (e.key) {
        case 'PageUp':
          go(neighborFloor(order, selectedProjectId, 'up'), 'up');
          break;
        case 'PageDown':
          go(neighborFloor(order, selectedProjectId, 'down'), 'down');
          break;
        case 'Home':
          go(firstFloor(order), 'down');
          break;
        case 'End':
          go(topProjectFloor(order), 'up');
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          setPickerOpen(true);
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [game]);

  // M8 8h: a Multiverse realm was clicked in the scene — travel there with the normal stairs
  // transition. `null` (the overflow realm) opens the floor picker instead (design section 6.3).
  useEffect(() => {
    if (!game) return;
    return game.on('realmClick', (projectId) => {
      if (!canNavigateFloors(game)) return;
      if (projectId === null) {
        setPickerOpen(true);
        return;
      }
      const { projects } = useOfficeStore.getState();
      const { settings } = useSettingsStore.getState();
      const target = projects[projectId];
      if (!target) return;
      const layouts = useLayoutStore.getState().layouts;
      void goToFloor(game, target, settings.office.floorTransitionMs, layouts, settings, showToast);
    });
  }, [game]);

  // M8 8b: the Guild Master's session-count chip was clicked — open its popover (`GmSessionsPopover`).
  useEffect(() => {
    if (!game) return;
    return game.on('gmSessions', (projectId) => setGmSessionsProjectId(projectId));
  }, [game]);

  // M8 8c: a resting hero (no live agent) was clicked — open the hero editor on it.
  useEffect(() => {
    if (!game) return;
    return game.on('heroClick', (heroId) => {
      const heroes = useHeroStore.getState().heroes;
      const hero = Object.hasOwn(heroes, heroId) ? heroes[heroId] : undefined;
      if (hero) useHeroPanelStore.getState().openHeroEditor(hero);
    });
  }, [game]);

  // Phaser measures its parent; re-fit when the tab becomes visible again.
  useEffect(() => {
    game?.setActive(active);
    if (active) window.dispatchEvent(new Event('resize'));
  }, [active, game]);

  // Report the panel's occupied edges as camera safe-insets, so the map can still be panned into
  // the part of the canvas that's left unobscured. Re-measured on resize (including the panel
  // collapsing to a bottom sheet on narrow screens) and cleared — with the scene animating the
  // camera back — once the panel closes.
  useEffect(() => {
    if (!game) return;
    if (!selected) {
      game.setSafeInsets(ZERO_INSETS);
      return;
    }
    const wrapEl = wrap.current;
    const drawerEl = drawer.current;
    if (!wrapEl || !drawerEl) return;
    const measure = () => game.setSafeInsets(insetsFromOverlay(wrapEl.getBoundingClientRect(), drawerEl.getBoundingClientRect()));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrapEl);
    ro.observe(drawerEl);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [game, selected]);

  // Esc closes the panel, unless the user is mid-typing in a text field (a checkbox like the
  // Follow toggle, or a button, has no text to lose, so Esc still closes from there).
  useEffect(() => {
    if (!selected) return;
    const NON_TEXT_INPUT_TYPES = new Set(['checkbox', 'radio', 'button', 'submit', 'range', 'color']);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTyping = tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !NON_TEXT_INPUT_TYPES.has((target as HTMLInputElement).type));
      if (isTyping) return;
      closePanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  useEffect(() => {
    game?.setFollow(follow ? selected : null);
  }, [game, follow, selected]);

  // M8 8d: the selected character glows (and, with `office.focusDim`, everyone else dims).
  useEffect(() => {
    game?.setSelected(selected);
  }, [game, selected]);

  const selectAgent = (id: string) => {
    setSelected(id);
    setFollow(false);
    game?.focus(id);
  };

  return (
    <div className="flex h-full min-h-0">
      <div ref={wrap} className="relative min-w-0 flex-1 bg-ink-900">
        <div ref={host} className="absolute inset-0" />
        <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap items-center gap-2">
          {overflow > 0 && (
            <span className="rounded-full bg-amber-500/90 px-2.5 py-1 text-[11px] font-semibold text-ink-950 shadow">
              +{overflow} more not shown (max {maxCharacters})
            </span>
          )}
          {agents.length === 0 && connection !== 'connecting' && (
            <span className="rounded-md bg-ink-850/90 px-3 py-2 text-xs text-ink-300 shadow">
              The office is quiet. Start a Claude Code session{connection === 'disconnected' ? ' — or open the demo from the top bar' : ''}.
            </span>
          )}
        </div>
        {toast && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <span className="rounded-full bg-ink-850/95 px-3 py-1.5 text-xs font-semibold text-ink-100 shadow-lg">{toast}</span>
          </div>
        )}
        <div className="absolute bottom-3 left-3 flex gap-1">
          <Button variant="subtle" onClick={() => game?.zoomBy(1.2)} aria-label="Zoom in">
            +
          </Button>
          <Button variant="subtle" onClick={() => game?.zoomBy(1 / 1.2)} aria-label="Zoom out">
            −
          </Button>
          <Button variant="subtle" onClick={() => game?.resetView()}>
            Fit
          </Button>
        </div>
        {selected && (
          <AgentDrawer
            agentId={selected}
            onClose={closePanel}
            follow={follow}
            onFollowChange={setFollow}
            rootRef={(el) => {
              drawer.current = el;
            }}
          />
        )}
      </div>
      <Roster agents={agents} selectedId={selected} onSelect={selectAgent} />
      {pickerOpen && <FloorManager onClose={() => setPickerOpen(false)} />}
      {gmSessionsProjectId && (
        <GmSessionsPopover
          projectId={gmSessionsProjectId}
          onClose={() => setGmSessionsProjectId(null)}
          onSelectAgent={(id) => {
            selectAgent(id);
            setGmSessionsProjectId(null);
          }}
        />
      )}
    </div>
  );
}
