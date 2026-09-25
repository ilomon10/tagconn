import { useEffect, useRef, useState } from 'react';
import { OfficeGame } from '../../game/OfficeGame';
import { onFloor, useOfficeStore } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useFloorAgents } from '../../lib/hooks';
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
  const [game, setGame] = useState<OfficeGame | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const agents = useFloorAgents();
  const maxCharacters = useSettingsStore((s) => s.settings.office.maxCharacters);
  const connection = useOfficeStore((s) => s.connection);
  const overflow = Math.max(0, agents.length - maxCharacters);

  useEffect(() => {
    if (!host.current) return;
    const g = new OfficeGame(host.current);
    const off = g.on('agentClick', (id) => setSelected(id));
    setGame(g);
    return () => {
      off();
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

  const selectAgent = (id: string) => {
    setSelected(id);
    game?.focus(id);
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1 bg-ink-900">
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
        {selected && <AgentDrawer agentId={selected} onClose={() => setSelected(null)} />}
      </div>
      <Roster agents={agents} selectedId={selected} onSelect={selectAgent} />
    </div>
  );
}
