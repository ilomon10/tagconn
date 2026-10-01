import { useMemo } from 'react';
import { ALL_FLOORS, useOfficeStore } from '../../../stores/officeStore';
import { useLayoutStore } from '../../../stores/layoutStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { floorStyleFor, useThemedRoleLookup, useBoundHero } from '../../../lib/hooks';
import { alertCopy } from './alertCopy';
import { AlertBox, EnemyPortrait } from './AlertBox';
import type { EncounterChoice } from '../../battle/types';
import { useAlertFeed } from './useAlertFeed';
import type { AlertItem } from './types';

function AlertEntry({ item, onShowMe, onDismiss, onChoose }: { item: AlertItem; onShowMe: (agentId: string) => void; onDismiss: (id: string) => void; onChoose: (item: AlertItem, c: EncounterChoice) => void }) {
  const agents = useOfficeStore((s) => s.agents);
  const atMultiverse = useOfficeStore((s) => s.selectedProjectId === ALL_FLOORS);
  const projects = useOfficeStore((s) => s.projects);
  const layouts = useLayoutStore((s) => s.layouts);
  const settings = useSettingsStore((s) => s.settings);
  const themed = useThemedRoleLookup();
  const lookup = (id: string) => agents[id] ?? item.agents?.[id];
  const first = lookup(item.agentIds[0] ?? '');
  const hero = useBoundHero(first?.id);
  const style = atMultiverse ? 'rift' : floorStyleFor(first ? projects[first.projectId] : undefined, layouts, settings);
  const names = useMemo(
    () => item.agentIds.map((id) => (id === first?.id && hero ? hero.name : themed(lookup(id)?.role, { projectId: lookup(id)?.projectId }).themedTitle)),
    [item.agentIds, item.agents, agents, themed, hero, first?.id],
  );
  const enc = item.encounter;
  const copy = alertCopy(item, enc?.style ?? style, names, first?.description);
  if (enc) {
    return (
      <AlertBox
        kind={item.kind}
        agent={undefined}
        copy={copy}
        portrait={<EnemyPortrait kind={enc.kind} style={enc.style} />}
        actions={[
          { label: 'Battle', primary: true, sfx: 'ui-confirm', onClick: () => onChoose(item, 'battle') },
          { label: 'Ignore', sfx: 'ui-back', onClick: () => onChoose(item, 'ignore') },
        ]}
        onShowMe={() => {}}
        onDismiss={() => onChoose(item, 'ignore')}
      />
    );
  }
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
  const { visible, dismiss, choose } = useAlertFeed();
  return (
    <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-2 top-14 z-20 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-3 sm:top-3">
      {visible.map((item) => (
        <AlertEntry key={item.id} item={item} onShowMe={onShowMe} onDismiss={dismiss} onChoose={choose} />
      ))}
    </div>
  );
}
