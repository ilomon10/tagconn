import { useCallback, useEffect, useRef, useState } from 'react';
import { sfxBus, type SfxId } from '../../../game/sfxBus';
import { onFloor, useOfficeStore } from '../../../stores/officeStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { dismissAlert, initialAlertQueue, offerAlert, tickAlerts } from './alertQueue';
import { alertsFromAgents, alertsFromEvents, withAgentSnapshots } from './alertSources';
import type { AlertItem, AlertKind, AlertQueueState } from './types';

const TICK_MS = 500;
const SFX: Record<AlertKind, SfxId> = { ask: 'alert-ask', failure: 'alert-fail', done: 'alert-done' };

/**
 * Feeds the alert queue from the office store (status transitions and tool-failure events), ticks it every
 * 500 ms and plays the alert sfx for each box shown. The hidden-tab case stays with `lib/notify.ts`.
 */
export function useAlertFeed(): { visible: readonly AlertItem[]; dismiss: (id: string) => void } {
  const [visible, setVisible] = useState<readonly AlertItem[]>([]);
  const queue = useRef<AlertQueueState | null>(null);

  useEffect(() => {
    const cfg = () => useSettingsStore.getState().settings.office.alerts;
    const floor = (projectId: string) => onFloor(useOfficeStore.getState().selectedProjectId, projectId);
    queue.current = initialAlertQueue(cfg(), Date.now());
    let prevAgents = useOfficeStore.getState().agents;
    let afterId = useOfficeStore.getState().events.reduce((m, e) => Math.max(m, e.id), 0);

    const offer = (state: AlertQueueState, inputs: ReturnType<typeof alertsFromAgents>, now: number) =>
      withAgentSnapshots(inputs, useOfficeStore.getState().agents, prevAgents).reduce((s, i) => offerAlert(s, i, cfg(), now), state);

    const unsub = useOfficeStore.subscribe((s) => {
      const q = queue.current;
      if (!q) return;
      const now = Date.now();
      let next = q;
      if (s.agents !== prevAgents) {
        next = offer(next, alertsFromAgents(prevAgents, s.agents, floor, now), now);
        prevAgents = s.agents;
      }
      const ev = alertsFromEvents(s.events, afterId, floor, now);
      afterId = ev.lastId;
      next = offer(next, ev.inputs, now);
      queue.current = next;
    });

    const timer = setInterval(() => {
      const q = queue.current;
      if (!q) return;
      const r = tickAlerts(q, cfg(), Date.now(), document.visibilityState === 'hidden');
      queue.current = r.state;
      for (const item of r.shown) sfxBus.emit({ id: SFX[item.kind] });
      setVisible((old) => (old.length === r.state.visible.length && old.every((o, i) => o.id === r.state.visible[i]?.id) ? old : r.state.visible));
    }, TICK_MS);

    return () => {
      unsub();
      clearInterval(timer);
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    if (!queue.current) return;
    queue.current = dismissAlert(queue.current, id);
    setVisible(queue.current.visible);
  }, []);

  return { visible, dismiss };
}
