// M14 AU1: the battle music (docs/design/battles.md 3.2). A 4-bar chiptune loop per style is baked into one buffer
// (square lead, triangle bass, noise hats): pure and deterministic, no timers, like the ambient beds.
import { mulberry32 } from './sfxr';
import type { MusicStyle } from './types';

interface Song {
  bpm: number;
  /** Bass root (MIDI) per bar; the bass alternates root / octave on eighth notes. */
  bass: number[];
  /** 8 eighth-note lead pitches per bar (MIDI, 0 = rest). */
  lead: number[][];
  duty: number;
  hatEvery: number; // hat on every n-th eighth (offset 1)
  seed: number;
}

const SONGS: Record<MusicStyle, Song> = {
  // A minor: Am F C G, driving and bright.
  modern: {
    bpm: 150, bass: [45, 41, 48, 43], duty: 0.5, hatEvery: 2, seed: 41,
    lead: [
      [76, 0, 72, 76, 81, 0, 79, 76],
      [77, 0, 72, 77, 81, 0, 79, 77],
      [76, 0, 79, 76, 72, 0, 74, 76],
      [74, 0, 79, 74, 71, 0, 74, 79],
    ],
  },
  // D dorian: Dm C Bb C, a tavern romp.
  guild: {
    bpm: 128, bass: [38, 36, 34, 36], duty: 0.25, hatEvery: 4, seed: 43,
    lead: [
      [74, 77, 81, 77, 74, 0, 72, 74],
      [72, 76, 79, 76, 72, 0, 70, 72],
      [70, 74, 77, 74, 70, 0, 72, 74],
      [72, 76, 79, 81, 79, 0, 76, 72],
    ],
  },
  // E phrygian: Em F Em D, tense and wide.
  rift: {
    bpm: 136, bass: [40, 41, 40, 38], duty: 0.125, hatEvery: 4, seed: 47,
    lead: [
      [71, 0, 76, 0, 77, 76, 0, 71],
      [72, 0, 77, 0, 79, 77, 0, 72],
      [71, 0, 76, 0, 83, 79, 0, 76],
      [74, 0, 78, 0, 81, 78, 0, 74],
    ],
  },
};

const midiHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

/** Loop length in seconds (4 bars of 4/4). */
export function musicLoopSeconds(style: MusicStyle): number {
  return (16 * 60) / SONGS[style].bpm;
}

/** Renders one loop to mono samples, peak 0.8. Same style + rate = same samples. */
export function renderMusicLoop(style: MusicStyle, sampleRate: number): Float32Array {
  const song = SONGS[style];
  const eighth = 30 / song.bpm;
  const out = new Float32Array(Math.round(musicLoopSeconds(style) * sampleRate));
  const rnd = mulberry32(song.seed);
  const voice = (start: number, len: number, hz: number, amp: number, wave: 'square' | 'triangle'): void => {
    const s0 = Math.round(start * sampleRate);
    const n = Math.min(Math.round(len * sampleRate), out.length - s0);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      phase += hz / sampleRate;
      phase -= Math.floor(phase);
      const raw = wave === 'square' ? (phase < song.duty ? 1 : -1) : 4 * Math.abs(phase - 0.5) - 1;
      // Short attack, held body, release before the note ends: no clicks and no overlap across the loop seam.
      const env = Math.min(1, i / (0.004 * sampleRate)) * Math.min(1, (1 - t) / 0.25);
      out[s0 + i] = (out[s0 + i] ?? 0) + raw * env * amp;
    }
  };
  for (let bar = 0; bar < 4; bar++) {
    const root = song.bass[bar] ?? 45;
    const lead = song.lead[bar] ?? [];
    for (let step = 0; step < 8; step++) {
      const at = (bar * 8 + step) * eighth;
      voice(at, eighth * 0.9, midiHz(step % 2 === 0 ? root : root + 12), 0.55, 'triangle');
      const note = lead[step] ?? 0;
      if (note > 0) voice(at, eighth * 0.85, midiHz(note), 0.28, 'square');
      if (step % song.hatEvery === 1) {
        const s0 = Math.round(at * sampleRate);
        const n = Math.round(0.03 * sampleRate);
        for (let i = 0; i < n && s0 + i < out.length; i++) out[s0 + i] = (out[s0 + i] ?? 0) + (rnd() * 2 - 1) * (1 - i / n) * 0.12;
      }
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = ((out[i] ?? 0) / peak) * 0.8;
  return out;
}

/** Starts the looping track into `out`, fading in over `fadeMs`. `stop(fadeMs)` fades out and tears down. */
export function createMusic(ctx: BaseAudioContext, style: MusicStyle, out: AudioNode, fadeMs: number): { stop(fadeMs: number): void } {
  const data = renderMusicLoop(style, ctx.sampleRate);
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.getChannelData(0).set(data);
  const bus = ctx.createGain();
  const now = ctx.currentTime;
  bus.gain.setValueAtTime(0, now);
  bus.gain.linearRampToValueAtTime(1, now + Math.max(0.01, fadeMs / 1000));
  bus.connect(out);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(bus);
  src.start();
  let stopped = false;
  return {
    stop(ms) {
      if (stopped) return;
      stopped = true;
      const s = Math.max(0.01, ms / 1000);
      const t = ctx.currentTime;
      bus.gain.cancelScheduledValues(t);
      bus.gain.setValueAtTime(bus.gain.value, t);
      bus.gain.linearRampToValueAtTime(0, t + s);
      try {
        src.stop(t + s);
      } catch {
        /* already stopped */
      }
      setTimeout(() => {
        try {
          src.disconnect();
          bus.disconnect();
        } catch {
          /* already disconnected */
        }
      }, (s + 0.1) * 1000);
    },
  };
}
