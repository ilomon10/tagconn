import type { SfxId } from '../../game/sfxBus';

export type AmbientKind = 'office-day' | 'office-night' | 'tavern-day' | 'tavern-night' | 'rift';
export type Wave = 'square' | 'saw' | 'triangle' | 'sine' | 'noise';
/** sfxr-style parameters; times in seconds, frequencies in Hz. */
export interface SfxParams {
  wave: Wave;
  attack: number; sustain: number; decay: number; punch?: number; // punch 0..1 sustain boost
  freq: number; slide?: number; // Hz per second
  vibratoHz?: number; vibratoDepth?: number; // depth 0..1 of freq
  duty?: number; // square 0..1
  lowpass?: number; highpass?: number; // one-pole cutoffs
  gain: number; // 0..1
  seed?: number; // noise determinism
  /** Melodic sequence (fanfare, gong, jingles): each note re-uses the envelope. */
  notes?: readonly { freq: number; at: number; len: number }[];
}
export type MusicStyle = 'modern' | 'guild' | 'rift';
export interface AudioMix { master: number; sfx: boolean; ambient: boolean; alerts: boolean; footsteps: boolean }
export interface AudioPrefs { muted: boolean | null; volume: number | null }
export interface AudioEngine {
  readonly unlocked: boolean;
  setMix(m: AudioMix): void;
  play(id: SfxId, opts?: { gain?: number; pan?: number }): void;
  setAmbient(kind: AmbientKind | null): void;
  /** M14: the looping battle track; `null` fades it out. Ducks the ambient bed while it plays. */
  setMusic(style: MusicStyle | null, fadeMs?: number): void;
  destroy(): void;
}
