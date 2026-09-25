import { useEffect, useRef, useState } from 'react';
import { OfficeGame } from '../../game/OfficeGame';
import { onFloor, useOfficeStore } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFloorAgents } from '../../lib/hooks';
import { ZERO_INSETS, insetsFromOverlay } from '../../game/camera/insets';
import { Roster } from './Roster';
import { AgentDrawer } from './AgentDrawer';
import { Button } from '../../components/ui';

/** Pushes store changes into the Phaser scene (the "bridge"). */
function useGameBridge(game: OfficeGame | null) {
  useEffect(() => {
    if (!game) return;
    const push = () => {
      const { agents, selectedProjectId } = useOfficeStore.getState();
      const { settings, roles } = useSettingsStore.getState();
      const floorAgents = Object.values(agents).filter((a) => onFloor(selectedProjectId, a.projectId));
      game.setState(floorAgents, settings, roles, selectedProjectId);
    };
    push();
    const unsubOffice = useOfficeStore.subscribe((s, p) => {
      if (s.agents !== p.agents || s.selectedProjectId !== p.selectedProjectId) push();
    });
    const unsubSettings = useSettingsStore.subscribe((s, p) => {
      if (s.settings !== p.settings || s.roles !== p.roles) push();
    });
    return () => {
      unsubOffice();
      unsubSettings();
    };
  }, [game]);
}

export function OfficeView({ active }: { active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const drawer = useRef<HTMLElement | null>(null);
  const [game, setGame] = useState<OfficeGame | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const agents = useFloorAgents();
  const maxCharacters = useSettingsStore((s) => s.settings.office.maxCharacters);
  const connection = useOfficeStore((s) => s.connection);
  const overflow = Math.max(0, agents.length - maxCharacters);

  const closePanel = () => {
    setSelected(null);
    setFollow(false);
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
    };
  }, []);

  useGameBridge(game);

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
    </div>
  );
}
