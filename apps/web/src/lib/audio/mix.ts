import type { Settings } from '@tagconn/shared';
import type { AudioMix, AudioPrefs } from './types';

/** Server defaults (`office.sound`, `office.audio`) overridden by the per-browser prefs; hidden tab = silent. */
export function resolveMix(office: Pick<Settings['office'], 'sound' | 'audio'>, prefs: AudioPrefs, hidden: boolean): AudioMix {
  const muted = prefs.muted ?? !office.sound;
  const { sfx, ambient, alerts, footsteps } = office.audio;
  return { master: hidden || muted ? 0 : (prefs.volume ?? office.audio.volume), sfx, ambient, alerts, footsteps };
}
