import { useCallback, useEffect, useRef, useState } from 'react';
import { sfxBus, type SfxId } from '../../../game/sfxBus';
import { onFloor, useOfficeStore } from '../../../stores/officeStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { encounterBus } from '../../battle/encounterBus';
import type { EncounterChoice } from '../../battle/types';
import { dismissAlert, initialAlertQueue, offerAlert, tickAlerts, withdrawAlert } from './alertQueue';
import { alertsFromAgents, alertsFromEvents, withAgentSnapshots } from './alertSources';
import type { AlertItem, AlertKind, AlertQueueState } from './types';

const TICK_MS = 500;
const SFX: Record<AlertKind, SfxId> = { ask: 'alert-ask', failure: 'alert-fail', done: 'alert-done', encounter: 'battle-encounter' };

/**
 * Feeds the alert queue from the office store (status transitions and tool-failure events), ticks it every
 * 500 ms and plays the alert sfx for each box shown. The hidden-tab case stays with `lib/notify.ts`.
 */
export function useAlertFeed(): { visible: readonly AlertItem[]; dismiss: (id: string) => void; choose: (item: AlertItem, c: EncounterChoice) => void } {
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

    const encounterIds = (q: AlertQueueState) => new Set([...q.pending, ...q.visible].filter((i) => i.kind === 'encounter').map((i) => i.agentIds[0]!));
    const unOffer = encounterBus.onOffer((o) => {
      const q = queue.current;
      if (!q) return;
      const before = encounterIds(q);
      const id = `encounter:${o.npcId}`;
      const now = Date.now();
      const c = cfg();
      const bc = useSettingsStore.getState().settings.battle;
      const next = offerAlert(q, { kind: 'encounter', agentId: id, key: 'appeared', at: now, encounter: o, ttlMs: bc.autoIgnoreSec * 1000 }, c, now);
      queue.current = next;
      // Refused (alerts off) or evicted by the pending cap: tell the flow so it releases the NPC.
      const after = encounterIds(next);
      if (!after.has(id)) encounterBus.choose(o.npcId, 'expired');
      for (const gone of before) if (!after.has(gone)) encounterBus.choose(gone.slice('encounter:'.length), 'expired');
    });
    const unWithdraw = encounterBus.onWithdraw((npcId) => {
      if (!queue.current) return;
      queue.current = withdrawAlert(queue.current, `encounter:${npcId}`);
      setVisible(queue.current.visible);
    });

    const timer = setInterval(() => {
      const q = queue.current;
      if (!q) return;
      const r = tickAlerts(q, cfg(), Date.now(), document.visibilityState === 'hidden');
      queue.current = r.state;
      for (const item of r.shown) {
        sfxBus.emit({ id: SFX[item.kind] });
        if (item.encounter) encounterBus.shown(item.encounter.npcId);
      }
      for (const item of r.expired) if (item.encounter) encounterBus.choose(item.encounter.npcId, 'expired');
      setVisible((old) => (old.length === r.state.visible.length && old.every((o, i) => o.id === r.state.visible[i]?.id) ? old : r.state.visible));
    }, TICK_MS);

    return () => {
      unsub();
      unOffer();
      unWithdraw();
      clearInterval(timer);
    };
  }, []);

  const dismiss = useCallback((id: string) => {
    if (!queue.current) return;
    queue.current = dismissAlert(queue.current, id);
    setVisible(queue.current.visible);
  }, []);

  const choose = useCallback((item: AlertItem, c: EncounterChoice) => {
    if (item.encounter) encounterBus.choose(item.encounter.npcId, c);
    dismiss(item.id);
  }, [dismiss]);

  return { visible, dismiss, choose };
}
