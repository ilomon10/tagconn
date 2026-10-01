import { useMemo } from 'react';
import { ALL_FLOORS, useOfficeStore } from '../../../stores/officeStore';
import { useLayoutStore } from '../../../stores/layoutStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { floorStyleFor, useThemedRoleLookup, useBoundHero } from '../../../lib/hooks';
import { alertCopy } from './alertCopy';
import { AlertBox } from './AlertBox';
import { useAlertFeed } from './useAlertFeed';
import type { AlertItem } from './types';

function AlertEntry({ item, onShowMe, onDismiss }: { item: AlertItem; onShowMe: (agentId: string) => void; onDismiss: (id: string) => void }) {
  const agents = useOfficeStore((s) => s.agents);
  const atMultiverse = useOfficeStore((s) => s.selectedProjectId === ALL_FLOORS);
  const projects = useOfficeStore((s) => s.projects);
  const layouts = useLayoutStore((s) => s.layouts);
  const settings = useSettingsStore((s) => s.settings);
  const themed = useThemedRoleLookup();
  const first = agents[item.agentIds[0] ?? ''];
  const hero = useBoundHero(first?.id);
  const style = atMultiverse ? 'rift' : floorStyleFor(first ? projects[first.projectId] : undefined, layouts, settings);
  const names = useMemo(
    () => item.agentIds.map((id) => (id === first?.id && hero ? hero.name : themed(agents[id]?.role, { projectId: agents[id]?.projectId }).themedTitle)),
    [item.agentIds, agents, themed, hero, first?.id],
  );
  const copy = alertCopy(item, style, names, first?.description);
  return (
    <AlertBox
      kind={item.kind}
      agent={first}
      copy={copy}
      onShowMe={() => {
        if (item.agentIds[0]) onShowMe(item.agentIds[0]);
        onDismiss(item.id);
      }}
      onDismiss={() => onDismiss(item.id)}
    />
  );
}

/**
 * The alert stack, top-right (phones: inset under the top bar). Non-modal: it never moves focus and does
 * not capture Esc; only the boxes take pointer events. `aria-live="polite"` announces each new box.
 */
export function AlertHost({ onShowMe }: { onShowMe: (agentId: string) => void }) {
  const { visible, dismiss } = useAlertFeed();
  return (
    <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-2 top-14 z-20 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-3 sm:top-3">
      {visible.map((item) => (
        <AlertEntry key={item.id} item={item} onShowMe={onShowMe} onDismiss={dismiss} />
      ))}
    </div>
  );
}
