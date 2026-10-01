import type { Settings } from '@tagconn/shared';
import type { AmbientContext } from '../../game/sfxBus';
import type { AudioMix, AudioPrefs } from './types';

/** Server defaults (`office.sound`, `office.audio`) overridden by the per-browser prefs; hidden tab = silent. */
export function resolveMix(office: Pick<Settings['office'], 'sound' | 'audio'>, prefs: AudioPrefs, hidden: boolean): AudioMix {
  const muted = prefs.muted ?? !office.sound;
  const { sfx, ambient, alerts, footsteps } = office.audio;
  return { master: hidden || muted ? 0 : (prefs.volume ?? office.audio.volume), sfx, ambient, alerts, footsteps };
}

/** Pure: the light flipped day/night on the same floor style (a floor switch changes the style, which stays silent). */
export function dayNightChanged(prev: AmbientContext | null, next: AmbientContext): boolean {
  return prev !== null && prev.style === next.style && prev.night !== next.night;
}
