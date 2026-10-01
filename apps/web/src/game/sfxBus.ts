// M13: a tiny typed bus between gameplay/UI emitters and the audio bridge (docs/design/office-life.md 2.2).
import type { Point } from './procgen/types';

export const SFX_IDS = [
  'alert-ask', 'alert-done', 'alert-fail',
  'footstep', 'typing',
  'door-bell', 'meeting-gong', 'npc-jingle-0', 'npc-jingle-1', 'npc-jingle-2', 'npc-jingle-3',
  'bark', 'meow', 'slime', 'whistle', 'roar', 'mop',
  'ui-click', 'ui-open', 'ui-close',
  'ui-select', 'ui-confirm', 'ui-back', 'ui-toggle', 'ui-tab', 'ui-hover', 'ui-error',
  'transition-floor', 'transition-multiverse', 'transition-daynight',
] as const;
export type SfxId = (typeof SFX_IDS)[number];
/** Which `office.audio` toggle gates an id (`ui` follows `sfx`). */
export type SfxCategory = 'alerts' | 'sfx' | 'footsteps' | 'ui';
export const SFX_CATEGORY: Record<SfxId, SfxCategory> = {
  'alert-ask': 'alerts', 'alert-done': 'alerts', 'alert-fail': 'alerts',
  footstep: 'footsteps', typing: 'footsteps',
  'door-bell': 'sfx', 'meeting-gong': 'sfx', 'npc-jingle-0': 'sfx', 'npc-jingle-1': 'sfx', 'npc-jingle-2': 'sfx', 'npc-jingle-3': 'sfx',
  bark: 'sfx', meow: 'sfx', slime: 'sfx', whistle: 'sfx', roar: 'sfx', mop: 'sfx',
  'ui-click': 'ui', 'ui-open': 'ui', 'ui-close': 'ui',
  'ui-select': 'ui', 'ui-confirm': 'ui', 'ui-back': 'ui', 'ui-toggle': 'ui', 'ui-tab': 'ui', 'ui-hover': 'ui', 'ui-error': 'ui',
  'transition-floor': 'ui', 'transition-multiverse': 'ui', 'transition-daynight': 'sfx',
};

export interface SfxEvent {
  id: SfxId;
  /** World px; omitted = non-spatial (UI, alerts). */
  at?: Point;
  /** 0..1 extra gain. */
  gain?: number;
}
/** World-space camera centre and half view size (OfficeScene sets it every proximity tick). */
export interface SfxListenerPose { x: number; y: number; halfW: number; halfH: number }
export interface AmbientContext { style: 'modern' | 'guild' | 'rift'; night: boolean }

export interface SfxBus {
  emit(e: SfxEvent): void;
  on(cb: (e: SfxEvent) => void): () => void;
  setListener(p: SfxListenerPose | null): void;
  listener(): SfxListenerPose | null;
  /** Replays the last context to late subscribers. */
  setAmbient(a: AmbientContext): void;
  ambient(): AmbientContext | null;
  onAmbient(cb: (a: AmbientContext) => void): () => void;
  /** Tests. */
  clear(): void;
}

function createSfxBus(): SfxBus {
  const subs = new Set<(e: SfxEvent) => void>();
  const ambientSubs = new Set<(a: AmbientContext) => void>();
  let listener: SfxListenerPose | null = null;
  let ambient: AmbientContext | null = null;
  // A throwing listener never breaks the emitter or the other listeners.
  const safe = <T>(cb: (v: T) => void, v: T): void => {
    try {
      cb(v);
    } catch {
      /* isolated */
    }
  };
  return {
    emit: (e) => {
      for (const cb of [...subs]) safe(cb, e);
    },
    on: (cb) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    setListener: (p) => {
      listener = p;
    },
    listener: () => listener,
    setAmbient: (a) => {
      ambient = a;
      for (const cb of [...ambientSubs]) safe(cb, a);
    },
    ambient: () => ambient,
    onAmbient: (cb) => {
      ambientSubs.add(cb);
      if (ambient) safe(cb, ambient);
      return () => void ambientSubs.delete(cb);
    },
    clear: () => {
      subs.clear();
      ambientSubs.clear();
      listener = null;
      ambient = null;
    },
  };
}

/** Module singleton, the same pattern as `officeNavBus`. */
export const sfxBus: SfxBus = createSfxBus();
