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
  // M14 battle presets (docs/design/battles.md 3.2): chiptune squares and triangles, soft edges. Times in seconds.
  'battle-encounter': {
    wave: 'square', duty: 0.25, attack: 0.005, sustain: 0.05, decay: 0.08, freq: 784, gain: 0.5, lowpass: 3600,
    notes: [{ freq: 784, at: 0, len: 0.1 }, { freq: 659, at: 0.1, len: 0.1 }, { freq: 784, at: 0.2, len: 0.1 }, { freq: 1047, at: 0.3, len: 0.28 }],
  },
  'battle-text': { wave: 'square', duty: 0.5, attack: 0.002, sustain: 0.006, decay: 0.014, freq: 1000, gain: 0.12, lowpass: 3000 },
  'battle-swirl': { wave: 'square', duty: 0.25, attack: 0.05, sustain: 0.5, decay: 0.1, freq: 220, slide: 1100, gain: 0.35, lowpass: 2800, vibratoHz: 14, vibratoDepth: 0.03 },
  'battle-sting': {
    wave: 'square', duty: 0.25, attack: 0.004, sustain: 0.03, decay: 0.05, freq: 988, gain: 0.45, lowpass: 3400,
    notes: [{ freq: 988, at: 0, len: 0.08 }, { freq: 1319, at: 0.07, len: 0.12 }],
  },
  'battle-return': { wave: 'noise', attack: 0.05, sustain: 0.1, decay: 0.15, freq: 0, gain: 0.3, lowpass: 1400, highpass: 150, seed: 53 },
  'battle-hit': { wave: 'noise', attack: 0.002, sustain: 0.03, decay: 0.09, freq: 0, gain: 0.5, lowpass: 2200, highpass: 100, punch: 0.6, seed: 57 },
  'battle-hit-super': {
    wave: 'noise', attack: 0.002, sustain: 0.05, decay: 0.15, freq: 0, gain: 0.58, lowpass: 3200, highpass: 80, punch: 0.9, seed: 59,
  },
  'battle-hit-weak': { wave: 'noise', attack: 0.002, sustain: 0.015, decay: 0.06, freq: 0, gain: 0.3, lowpass: 1100, highpass: 150, punch: 0.3, seed: 61 },
  'battle-crit': {
    wave: 'square', duty: 0.25, attack: 0.002, sustain: 0.04, decay: 0.12, freq: 1568, slide: -1800, gain: 0.55, lowpass: 4200, punch: 0.8,
  },
  'battle-miss': { wave: 'noise', attack: 0.04, sustain: 0.05, decay: 0.1, freq: 0, gain: 0.25, lowpass: 1800, highpass: 600, seed: 67 },
  'battle-heal': {
    wave: 'triangle', attack: 0.01, sustain: 0.05, decay: 0.12, freq: 523, gain: 0.45, lowpass: 4000,
    notes: seq([523, 659, 784, 1047], 0.08, 0.16),
  },
  'battle-buff': { wave: 'square', duty: 0.25, attack: 0.01, sustain: 0.12, decay: 0.12, freq: 440, slide: 900, gain: 0.35, lowpass: 3200 },
  'battle-shield': { wave: 'triangle', attack: 0.005, sustain: 0.1, decay: 0.2, freq: 330, slide: 120, gain: 0.45, lowpass: 2400, punch: 0.5, vibratoHz: 30, vibratoDepth: 0.03 },
  'battle-status': { wave: 'saw', attack: 0.02, sustain: 0.15, decay: 0.2, freq: 330, slide: -180, gain: 0.35, lowpass: 1500, vibratoHz: 16, vibratoDepth: 0.1 },
  'battle-faint': { wave: 'square', duty: 0.5, attack: 0.01, sustain: 0.25, decay: 0.2, freq: 440, slide: -600, gain: 0.4, lowpass: 2200 },
  'battle-enemy-faint': { wave: 'square', duty: 0.25, attack: 0.01, sustain: 0.2, decay: 0.25, freq: 660, slide: -420, gain: 0.4, lowpass: 2400, vibratoHz: 20, vibratoDepth: 0.06 },
  'battle-swap': { wave: 'triangle', attack: 0.01, sustain: 0.06, decay: 0.12, freq: 400, slide: 900, gain: 0.35, lowpass: 3000 },
  'battle-item': {
    wave: 'triangle', attack: 0.005, sustain: 0.03, decay: 0.07, freq: 784, gain: 0.4, lowpass: 3400,
    notes: [{ freq: 784, at: 0, len: 0.08 }, { freq: 1175, at: 0.07, len: 0.12 }],
  },
  'battle-run': { wave: 'square', duty: 0.5, attack: 0.01, sustain: 0.18, decay: 0.12, freq: 300, slide: 1200, gain: 0.35, lowpass: 3000, vibratoHz: 22, vibratoDepth: 0.05 },
  'battle-victory': {
    wave: 'square', duty: 0.25, attack: 0.005, sustain: 0.08, decay: 0.12, freq: 523, gain: 0.5, lowpass: 3800,
    notes: [
      { freq: 523, at: 0, len: 0.14 }, { freq: 523, at: 0.16, len: 0.14 }, { freq: 523, at: 0.32, len: 0.14 },
      { freq: 659, at: 0.48, len: 0.2 }, { freq: 523, at: 0.72, len: 0.14 }, { freq: 784, at: 0.88, len: 0.5 },
    ],
  },
  'battle-defeat': {
    wave: 'triangle', attack: 0.01, sustain: 0.15, decay: 0.25, freq: 392, gain: 0.5, lowpass: 1800,
    notes: [{ freq: 392, at: 0, len: 0.3 }, { freq: 330, at: 0.3, len: 0.3 }, { freq: 262, at: 0.6, len: 0.3 }, { freq: 196, at: 0.9, len: 0.5 }],
  },
  'battle-level-up': {
    wave: 'square', duty: 0.25, attack: 0.005, sustain: 0.06, decay: 0.1, freq: 523, gain: 0.5, lowpass: 4000,
    notes: [
      { freq: 523, at: 0, len: 0.12 }, { freq: 659, at: 0.1, len: 0.12 }, { freq: 784, at: 0.2, len: 0.12 },
      { freq: 1047, at: 0.3, len: 0.12 }, { freq: 784, at: 0.42, len: 0.1 }, { freq: 1047, at: 0.52, len: 0.1 }, { freq: 1319, at: 0.62, len: 0.6 },
    ],
  },
  'battle-loot': {
    wave: 'sine', attack: 0.003, sustain: 0.03, decay: 0.1, freq: 1319, gain: 0.45, punch: 0.4,
    notes: [{ freq: 1319, at: 0, len: 0.1 }, { freq: 1760, at: 0.07, len: 0.25 }],
  },
  'battle-xp-tick': { wave: 'square', duty: 0.5, attack: 0.002, sustain: 0.008, decay: 0.02, freq: 1200, gain: 0.2, lowpass: 3200 },
};

// Compile-time/runtime guard that no id is missing.
for (const id of SFX_IDS) if (!SFX_PRESETS[id]) throw new Error(`missing SFX preset: ${id}`);
