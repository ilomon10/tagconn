// M13 W1-5: the sound effects, all code-synthesised (ADR #22). Soft envelopes and low-passed edges keep them gentle.
import { SFX_IDS, type SfxId } from '../../game/sfxBus';
import type { SfxParams } from './types';

/** Note helper: evenly spaced notes. */
const seq = (freqs: number[], step: number, len: number): { freq: number; at: number; len: number }[] =>
  freqs.map((freq, i) => ({ freq, at: i * step, len }));

// Pentatonic-ish pitches (C5 523, D5 587, E5 659, G5 784, A5 880, C6 1047).
const JINGLE = (freqs: number[]): SfxParams => ({
  wave: 'triangle', attack: 0.01, sustain: 0.05, decay: 0.09, freq: freqs[0] ?? 523, gain: 0.45, lowpass: 3200,
  notes: seq(freqs, 0.11, 0.16),
});

/** M14 W0w placeholder: a barely audible blip until AU1 writes the real battle presets. */
const BLANK: SfxParams = { wave: 'sine', attack: 0.004, sustain: 0.01, decay: 0.03, freq: 440, gain: 0.15 };

export const SFX_PRESETS: Record<SfxId, SfxParams> = {
  'alert-ask': {
    wave: 'square', duty: 0.25, attack: 0.01, sustain: 0.08, decay: 0.12, freq: 660, gain: 0.4, lowpass: 2600,
    notes: [{ freq: 660, at: 0, len: 0.14 }, { freq: 880, at: 0.14, len: 0.2 }],
  },
  'alert-done': {
    wave: 'triangle', attack: 0.01, sustain: 0.06, decay: 0.12, freq: 523, gain: 0.5, lowpass: 3600,
    notes: seq([523, 659, 784, 1047], 0.1, 0.2),
  },
  'alert-fail': {
    wave: 'triangle', attack: 0.015, sustain: 0.08, decay: 0.15, freq: 330, gain: 0.45, lowpass: 1800,
    notes: [{ freq: 392, at: 0, len: 0.18 }, { freq: 294, at: 0.16, len: 0.3 }],
  },
  footstep: { wave: 'noise', attack: 0.004, sustain: 0.01, decay: 0.05, freq: 0, gain: 0.3, lowpass: 700, seed: 7 },
  typing: { wave: 'noise', attack: 0.002, sustain: 0.004, decay: 0.03, freq: 0, gain: 0.22, lowpass: 3500, highpass: 900, seed: 11 },
  'door-bell': {
    wave: 'sine', attack: 0.005, sustain: 0.1, decay: 0.55, freq: 1175, gain: 0.45, punch: 0.3,
    notes: [{ freq: 1175, at: 0, len: 0.5 }, { freq: 880, at: 0.22, len: 0.7 }],
  },
  'meeting-gong': {
    wave: 'sine', attack: 0.01, sustain: 0.3, decay: 0.9, freq: 110, gain: 0.55, punch: 0.4, vibratoHz: 5, vibratoDepth: 0.01,
    notes: [{ freq: 110, at: 0, len: 1.4 }, { freq: 165, at: 0, len: 1.2 }],
  },
  'npc-jingle-0': JINGLE([523, 659, 784]),
  'npc-jingle-1': JINGLE([784, 659, 587, 784]),
  'npc-jingle-2': JINGLE([440, 523, 440, 659]),
  'npc-jingle-3': JINGLE([587, 784, 880, 1047]),
  bark: { wave: 'square', duty: 0.4, attack: 0.005, sustain: 0.04, decay: 0.1, freq: 330, slide: -500, gain: 0.4, lowpass: 1600, punch: 0.3 },
  meow: { wave: 'triangle', attack: 0.06, sustain: 0.12, decay: 0.22, freq: 600, slide: 300, gain: 0.4, lowpass: 2400, vibratoHz: 7, vibratoDepth: 0.03 },
  slime: { wave: 'sine', attack: 0.01, sustain: 0.1, decay: 0.2, freq: 180, slide: 500, gain: 0.4, vibratoHz: 18, vibratoDepth: 0.15 },
  whistle: { wave: 'sine', attack: 0.04, sustain: 0.25, decay: 0.2, freq: 1500, slide: 600, gain: 0.35, vibratoHz: 6, vibratoDepth: 0.02 },
  roar: { wave: 'saw', attack: 0.08, sustain: 0.3, decay: 0.4, freq: 90, slide: -30, gain: 0.45, lowpass: 600, vibratoHz: 24, vibratoDepth: 0.08 },
  mop: { wave: 'noise', attack: 0.06, sustain: 0.1, decay: 0.2, freq: 0, gain: 0.25, lowpass: 900, highpass: 150, seed: 23 },
  'ui-click': { wave: 'square', duty: 0.5, attack: 0.002, sustain: 0.008, decay: 0.03, freq: 900, gain: 0.25, lowpass: 3000 },
  'ui-open': { wave: 'triangle', attack: 0.005, sustain: 0.03, decay: 0.08, freq: 500, slide: 1200, gain: 0.3, lowpass: 3000 },
  'ui-close': { wave: 'triangle', attack: 0.005, sustain: 0.03, decay: 0.08, freq: 900, slide: -1200, gain: 0.3, lowpass: 3000 },
  // Soft UI feedback: triangle/sine, low-passed, quiet, <= 0.15 s. Pitches stay in the same pentatonic family as the jingles.
  'ui-select': {
    wave: 'triangle', attack: 0.004, sustain: 0.02, decay: 0.05, freq: 659, gain: 0.26, lowpass: 3200,
    notes: [{ freq: 659, at: 0, len: 0.07 }, { freq: 988, at: 0.05, len: 0.08 }],
  },
  'ui-confirm': {
    wave: 'triangle', attack: 0.004, sustain: 0.025, decay: 0.06, freq: 523, gain: 0.3, lowpass: 3400,
    notes: [{ freq: 523, at: 0, len: 0.06 }, { freq: 659, at: 0.04, len: 0.06 }, { freq: 784, at: 0.08, len: 0.06 }],
  },
  'ui-back': {
    wave: 'triangle', attack: 0.004, sustain: 0.02, decay: 0.05, freq: 587, gain: 0.26, lowpass: 2800,
    notes: [{ freq: 587, at: 0, len: 0.07 }, { freq: 392, at: 0.05, len: 0.08 }],
  },
  'ui-toggle': { wave: 'sine', attack: 0.003, sustain: 0.012, decay: 0.04, freq: 740, slide: 700, gain: 0.26 },
  'ui-tab': { wave: 'triangle', attack: 0.003, sustain: 0.01, decay: 0.035, freq: 784, gain: 0.22, lowpass: 3000 },
  'ui-hover': { wave: 'sine', attack: 0.004, sustain: 0.004, decay: 0.025, freq: 1320, gain: 0.08, lowpass: 3000 },
  'ui-error': { wave: 'triangle', attack: 0.004, sustain: 0.05, decay: 0.07, freq: 220, slide: -60, gain: 0.3, lowpass: 1200 },
  // Transitions: slow soft sweeps (<= 0.4 s) played as the animation starts.
  'transition-floor': { wave: 'noise', attack: 0.09, sustain: 0.1, decay: 0.2, freq: 0, gain: 0.2, lowpass: 900, highpass: 120, seed: 31 },
  'transition-multiverse': {
    wave: 'sine', attack: 0.08, sustain: 0.12, decay: 0.2, freq: 330, slide: 700, gain: 0.24, vibratoHz: 9, vibratoDepth: 0.02,
  },
  'transition-daynight': {
    wave: 'sine', attack: 0.01, sustain: 0.06, decay: 0.2, freq: 784, gain: 0.2,
    notes: [{ freq: 784, at: 0, len: 0.2 }, { freq: 1047, at: 0.12, len: 0.26 }],
  },
  // Battle presets: blank until AU1.
  'battle-encounter': BLANK, 'battle-text': BLANK,
  'battle-swirl': BLANK,
  'battle-sting': BLANK,
  'battle-return': BLANK,
  'battle-hit': BLANK,
  'battle-hit-super': BLANK,
  'battle-hit-weak': BLANK,
  'battle-crit': BLANK,
  'battle-miss': BLANK,
  'battle-heal': BLANK,
  'battle-buff': BLANK,
  'battle-shield': BLANK,
  'battle-status': BLANK,
  'battle-faint': BLANK,
  'battle-enemy-faint': BLANK,
  'battle-swap': BLANK,
  'battle-item': BLANK,
  'battle-run': BLANK,
  'battle-victory': BLANK,
  'battle-defeat': BLANK,
  'battle-level-up': BLANK,
  'battle-loot': BLANK,
  'battle-xp-tick': BLANK,
};

// Compile-time/runtime guard that no id is missing.
for (const id of SFX_IDS) if (!SFX_PRESETS[id]) throw new Error(`missing SFX preset: ${id}`);
