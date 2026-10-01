// STUB (W0b): W1-6 owns the mix resolution. Master 0 keeps the app silent until then.
import type { Settings } from '@tagconn/shared';
import type { AudioMix, AudioPrefs } from './types';

export function resolveMix(_office: Pick<Settings['office'], 'sound' | 'audio'>, _prefs: AudioPrefs, _hidden: boolean): AudioMix {
  return { master: 0, sfx: false, ambient: false, alerts: false, footsteps: false };
}
