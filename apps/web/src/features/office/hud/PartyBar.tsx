import { useEffect, useRef, useState } from 'react';
import type { Agent } from '@tagconn/shared';
import { useNow } from '../../../lib/hooks';
import { strainFor } from '../../../game/drama';
import { useSettingsStore } from '../../../stores/settingsStore';
import { Button, Checkbox, Empty, cx } from '../../../components/ui';
import { useHiddenAgentIds } from '../useHiddenAgentIds';
import { AgentRow } from './AgentRows';
import { PortraitChip } from './PortraitChip';

interface PartyBarProps {
  /** In roster order (`useFloorAgents()`), so `[`/`]` cycling matches the bar left to right. */
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Phones: the bar collapses to a pill that opens the tray. */
  phone: boolean;
  trayOpen: boolean;
  onTrayOpenChange: (open: boolean) => void;
}

/**
 * The party: one portrait chip per character along the bottom (docs/design/game-office.md section 3.1).
 * Off-canvas members (idle, over the cap, ...) sit behind a trailing `+N off canvas` chip. On a phone it
 * is the pill; the open tray holds the chips in a wrapping grid plus per-agent rows. Selecting a chip
 * hands over to `onSelect`, which also closes the tray.
 */
export function PartyBar({ agents, selectedId, onSelect, phone, trayOpen, onTrayOpenChange }: PartyBarProps) {
  const now = useNow();
  const drama = useSettingsStore((s) => s.settings.office.drama);
  const hidden = useHiddenAgentIds(agents, now);
  const [showOffCanvas, setShowOffCanvas] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const shown = showOffCanvas ? agents : agents.filter((a) => !hidden.has(a.id));
  const offCanvasCount = agents.filter((a) => hidden.has(a.id)).length;
  const working = agents.filter((a) => a.status !== 'done').length;

  // Keep the selected chip in view when `[`/`]` or a click in the scene changes the selection.
  useEffect(() => {
    const chip = selectedId ? scroller.current?.querySelector(`[data-agent-chip="${CSS.escape(selectedId)}"]`) : null;
    chip?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [selectedId, showOffCanvas]);

  if (agents.length === 0) return null;

  const chip = (a: Agent) => (
    <PortraitChip key={a.id} agent={a} selected={a.id === selectedId} offCanvas={hidden.has(a.id)} strain={strainFor(a, now, drama, false)} onSelect={() => onSelect(a.id)} />
  );
  const offToggle = offCanvasCount > 0 && (
    <button
      type="button"
      onClick={() => setShowOffCanvas((v) => !v)}
      aria-expanded={showOffCanvas}
      title="Idle, unbound or over the character cap: not drawn in the office right now"
      className="grid h-12 shrink-0 place-items-center rounded-xl border border-dashed border-ink-600 px-2.5 text-[11px] font-medium text-ink-300 transition-[background-color,transform] duration-150 hover:bg-ink-800 active:scale-[0.97] coarse:h-14"
    >
      {showOffCanvas ? 'Hide' : `+${offCanvasCount}`} off canvas
    </button>
  );

  if (!phone) {
    return (
      // The wrapper keeps clear of the zoom buttons (left) and mirrors that gap so the bar stays centred.
      <div className="pointer-events-none absolute inset-x-[10.5rem] bottom-3 z-10 flex justify-center">
        <div
          role="group"
          aria-label="Party"
          data-camera-overlay="bottom"
          className="pointer-events-auto flex max-w-full items-center rounded-2xl border border-ink-600/70 bg-ink-850/90 shadow-lg backdrop-blur"
        >
          <div
            ref={scroller}
            className="flex items-center gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1.5 pt-2.5 [mask-image:linear-gradient(to_right,transparent,#000_12px,#000_calc(100%-12px),transparent)] [scrollbar-width:none]"
          >
            {shown.map(chip)}
            {offToggle}
          </div>
        </div>
      </div>
    );
  }

  if (!trayOpen) {
    return (
      <button
        type="button"
        onClick={() => onTrayOpenChange(true)}
        aria-expanded={false}
        className="absolute bottom-3 right-3 z-10 flex min-h-11 items-center gap-2 rounded-full border border-ink-600/70 bg-ink-850/95 px-3.5 text-xs font-medium text-ink-100 shadow-lg backdrop-blur transition-transform duration-150 ease-out active:scale-[0.97]"
      >
        <span className="size-2 rounded-full bg-emerald-400" aria-hidden="true" />
        Party
        <span className="font-pixel text-[11px] text-ink-300">
          {working}/{agents.length}
        </span>
      </button>
    );
  }

  return (
    <aside
      role="region"
      aria-label="Party"
      data-camera-overlay
      className="anim-sheet absolute inset-x-0 bottom-0 z-20 flex max-h-[55%] flex-col rounded-t-xl border-t border-ink-700 bg-ink-850/95 pb-[env(safe-area-inset-bottom)] shadow-2xl backdrop-blur side:inset-x-auto side:inset-y-0 side:right-0 side:max-h-none side:w-[min(24rem,60%)] side:rounded-none side:border-l side:border-t-0"
    >
      <header className="flex items-center justify-between gap-2 border-b border-ink-700 px-3 py-2">
        <h2 className="text-xs font-semibold tracking-wide">Party</h2>
        <span className="ml-auto text-[11px] text-ink-300">
          {working} working · {agents.length} total
        </span>
        <Button variant="ghost" onClick={() => onTrayOpenChange(false)} aria-label="Close party" title="Close party">
          ✕
        </Button>
      </header>
      {offCanvasCount > 0 && (
        <div className="flex items-center justify-between border-b border-ink-700 px-3 py-1.5">
          <span className="text-[11px] text-ink-300">{offCanvasCount} off canvas</span>
          <Checkbox checked={showOffCanvas} onChange={setShowOffCanvas} label="Show off-canvas" />
        </div>
      )}
      {shown.length === 0 ? (
        <Empty>Everyone here is off canvas. Turn on "Show off-canvas" to list them.</Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="flex flex-wrap gap-2 px-3 pb-1 pt-3">{shown.map(chip)}</div>
          <ul className={cx('space-y-1 p-2')}>
            {shown.map((a) => (
              <AgentRow key={a.id} agent={a} now={now} selected={a.id === selectedId} onSelect={() => onSelect(a.id)} offCanvas={hidden.has(a.id)} />
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}
