// M14 F1: runs the battle flow machine (docs/design/battles.md 3.3 / 3.10). Holds the flow in a zustand store and executes
// the reducer's effects against the office game, the encounter bus and the battle commands.
import { useEffect } from 'react';
import { heroLookForStyle, MULTIVERSE_FLOOR_ID, type BattleNpcKind, type BattleSetup, type PartyRef } from '@tagconn/shared';
import { create } from 'zustand';
import { FALLBACK_COLOR } from '../../lib/defaultRoles';
import { anonymousAppearance } from '../../game/heroPreview';
import { createBattleController } from '../../game/battle/controller';
import { hexToNumber } from '../../game/textures';
import { prefersReducedMotion } from '../../game/themes';
import type { BattleController, BattlerLook, BattleSceneHandle, BattleSceneInput, BattleStyle } from '../../game/battle/types';
import type { EncounterEvent } from '../../game/npc/types';
import { useAuthStore } from '../../stores/authStore';
import { useHeroStore } from '../../stores/heroStore';
import { useOfficeStore } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { abandonBattle, resolveBattle, startBattle } from './commands';
import { battleText } from './copy';
import { eventDurationMs } from './durations';
import { encounterBus } from './encounterBus';
import { shouldOfferEncounter } from './encounterRules';
import { IDLE, reduce } from './flowMachine';
import { candidateSource } from './party';
import type { EncounterOffer, FlowEffect, FlowEvent, FlowState } from './types';

/** The slice of `OfficeGame` the flow needs (the PM wires the real methods in, design 3.10). */
export interface BattleGameHost {
  holdEncounter(npcId: string): boolean;
  releaseEncounter(npcId: string): void;
  dismissEncounter(npcId: string): void;
  openBattle(input: BattleSceneInput): BattleSceneHandle | null;
  on(event: 'encounter', cb: (e: EncounterEvent) => void): () => void;
}

/** Live pieces of a battle that has a scene: the HUD reads them from the store. */
export interface BattleSession {
  controller: BattleController;
  style: BattleStyle;
  reduced: boolean;
  /** The entry transition finished: the HUD may show. */
  ready: boolean;
}

interface FlowStore {
  state: FlowState;
  session: BattleSession | null;
}

export const useFlowStore = create<FlowStore>()(() => ({ state: IDLE, session: null }));

let host: BattleGameHost | null = null;
let handle: BattleSceneHandle | null = null;

const flowState = (): FlowState => useFlowStore.getState().state;

/** Applies one event and runs its effects. Effects may dispatch follow-up events; the state is already stored by then. */
export function dispatch(e: FlowEvent): void {
  const step = reduce(flowState(), e);
  if (step.state !== flowState()) useFlowStore.setState({ state: step.state });
  for (const fx of step.effects) run(fx);
}

const toBattleStyle = (s: string): BattleStyle => (s === 'guild' || s === 'rift' ? s : 'modern');
const errorMessage = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong.');

/** The look of a party member (a hero or an anonymous agent) for the battle stage and the picker. Null when it is gone. */
export type PartyLook = Exclude<BattlerLook, { kind: 'enemy' }>;

export function lookForKey(key: string, style: BattleStyle): PartyLook | null {
  const src = candidateSource(key, useHeroStore.getState().heroes, useOfficeStore.getState().agents);
  if (!src) return null;
  const role = useSettingsStore.getState().roles.find((r) => r.name === src.role);
  const roleColor = hexToNumber(role?.color ?? FALLBACK_COLOR);
  if (src.hero && useSettingsStore.getState().settings.heroes.enabled) {
    return { kind: 'hero', appearance: heroLookForStyle(src.hero, style).appearance, role: src.role, roleColor, style };
  }
  return { kind: 'anon', role: src.role, roleColor, style };
}

/** `BattlerLook` for a setup's party ref. Heroes without a stored look fall back to the anonymous one. */
function battlerFor(ref: PartyRef, style: BattleStyle): BattlerLook {
  const key = ref.kind === 'hero' ? ref.heroId : `agent:${ref.agentId}`;
  const look = lookForKey(key, style);
  if (look) return look;
  return { kind: 'anon', role: 'developer', roleColor: hexToNumber(FALLBACK_COLOR), style };
}

/** Exported for the picker: the appearance to paint for a battler look (anonymous ones are generated per member). */
export function appearanceFor(look: PartyLook, seed: string) {
  if (look.kind === 'hero') return look.appearance;
  const sprite = useSettingsStore.getState().roles.find((r) => r.name === look.role)?.sprite ?? 0;
  return anonymousAppearance(seed, sprite);
}

function run(fx: FlowEffect): void {
  switch (fx.do) {
    case 'hold':
      // The NPC is already on its way out: nothing to fight.
      if (!host?.holdEncounter(fx.npcId)) dispatch({ t: 'withdraw', npcId: fx.npcId });
      return;
    case 'release':
      host?.releaseEncounter(fx.npcId);
      return;
    case 'dismiss':
      host?.dismissEncounter(fx.npcId);
      return;
    case 'withdrawAlert':
      encounterBus.withdraw(fx.npcId);
      return;
    case 'create': {
      const { offer, party } = fx;
      startBattle({ projectId: offer.projectId, npcKind: offer.kind, encounterId: offer.npcId, party: [...party] }).then(
        (start) => {
          const s = flowState();
          if (s.phase === 'starting' && s.offer.npcId === offer.npcId) dispatch({ t: 'started', start });
          else void abandonBattle(start.id).catch(() => undefined); // the flow was closed while the call was in flight
        },
        (err: unknown) => dispatch({ t: 'failed', message: errorMessage(err) }),
      );
      return;
    }
    case 'openScene':
      openScene(fx.start.setup, fx.start.id, flowState());
      return;
    case 'resolve':
      resolveBattle(fx.start.id, { log: [...fx.log], expect: { result: fx.result, turns: fx.turns } }).then(
        (outcome) => dispatch({ t: 'resolved', outcome }),
        (err: unknown) => dispatch({ t: 'failed', message: errorMessage(err) }),
      );
      return;
    case 'abandon':
      void abandonBattle(fx.battleId).catch(() => undefined);
      return;
    case 'closeScene': {
      const h = handle;
      const session = useFlowStore.getState().session;
      handle = null;
      useFlowStore.setState({ session: null });
      // The scene keeps ticking the controller through its return transition; destroy it afterwards.
      void (h?.close() ?? Promise.resolve()).catch(() => undefined).finally(() => session?.controller.destroy());
      return;
    }
  }
}

function openScene(setup: BattleSetup, battleId: string, state: FlowState): void {
  if (state.phase !== 'fighting' || !host) return;
  const style = state.offer.style;
  const reduced = prefersReducedMotion();
  const controller = createBattleController(setup, {
    text: (e, s, st) => battleText(e, s, st, style),
    durationMs: eventDurationMs,
    reduced,
    now: () => performance.now(),
  });
  const party = setup.party.map((m) => battlerFor(m.ref as PartyRef, style));
  const enemy: BattlerLook = { kind: 'enemy', npcKind: state.offer.kind, style };
  const h = host.openBattle({ controller, style, reducedMotion: reduced, party, enemy, insets: { bottom: 0 } });
  if (!h) {
    // The office is busy (a floor transition): give the battle back and let the NPC go on.
    controller.destroy();
    dispatch({ t: 'close' });
    return;
  }
  handle = h;
  useFlowStore.setState({ session: { controller, style, reduced, ready: false } });
  const off = controller.subscribe((v) => {
    const s = flowState();
    if (v.result && s.phase === 'fighting' && s.start.id === battleId) {
      off();
      dispatch({ t: 'ended', log: controller.actionLog(), result: v.result, turns: Math.max(0, v.state.turn - 1) });
    }
  });
  void h.ready.then(
    () => {
      const cur = useFlowStore.getState().session;
      if (cur?.controller === controller) useFlowStore.setState({ session: { ...cur, ready: true } });
    },
    () => undefined,
  );
}

/** Tells the stage how much of its bottom the HUD covers. */
export function setBattleInsets(bottom: number): void {
  handle?.setInsets({ bottom });
}

/** Wires the flow to the office game and the encounter bus for as long as the office view is mounted. */
export function useBattleFlow(game: BattleGameHost | null): void {
  useEffect(() => {
    if (!game) return;
    host = game;
    const canWrite = () => useOfficeStore.getState().connection === 'demo' || useAuthStore.getState().status.admin;
    const anyWaiting = () => Object.values(useOfficeStore.getState().agents).some((a) => a.status === 'waiting' || a.status === 'blocked');

    const offs = [
      game.on('encounter', (e) => {
        const s = flowState();
        if (e.phase === 'left') {
          dispatch({ t: 'withdraw', npcId: e.id });
          return;
        }
        const projectId = useOfficeStore.getState().selectedProjectId;
        const ok = shouldOfferEncounter(e, {
          settings: useSettingsStore.getState().settings,
          anyWaiting: anyWaiting(),
          canWrite: canWrite(),
          flowIdle: s.phase === 'idle',
          multiverse: projectId === MULTIVERSE_FLOOR_ID,
        });
        if (!ok) return;
        const offer: EncounterOffer = { npcId: e.id, kind: e.kind as BattleNpcKind, name: e.name, style: toBattleStyle(e.style), projectId, at: e.at };
        dispatch({ t: 'offer', offer });
        if (flowState().phase === 'offered') encounterBus.offer(offer);
      }),
      encounterBus.onShown((npcId) => dispatch({ t: 'shown', npcId })),
      encounterBus.onChoice((npcId, choice) => dispatch({ t: 'choice', npcId, choice })),
      encounterBus.onWithdraw((npcId) => dispatch({ t: 'withdraw', npcId })),
      // An agent that needs the user outranks a fight that has not started yet.
      useOfficeStore.subscribe((s, prev) => {
        const f = flowState();
        if ((f.phase === 'offered' || f.phase === 'prompt') && s.agents !== prev.agents && anyWaiting()) dispatch({ t: 'withdraw', npcId: f.offer.npcId });
        // Leaving the floor mid-flow ends it (a running battle is abandoned).
        if (f.phase !== 'idle' && s.selectedProjectId !== prev.selectedProjectId && s.selectedProjectId !== f.offer.projectId) dispatch({ t: 'close' });
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      dispatch({ t: 'close' }); // unmount: abandons a running battle
      host = null;
    };
  }, [game]);
}
