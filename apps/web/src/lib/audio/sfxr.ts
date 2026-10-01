// M13 W1-5: tiny sfxr-style synth (docs/design/office-life.md 3.7.2). Pure and deterministic: same params + rate = same samples.
import type { SfxParams } from './types';

/** Seeded PRNG (mulberry32), shared with the ambient beds. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shortest fade at both ends, so a zero attack or decay never clicks. */
const MIN_RAMP_S = 0.003;

function oneVoice(p: SfxParams, len: number, freq0: number, rate: number, rnd: () => number, out: Float32Array, start: number): void {
  const n = Math.min(out.length - start, Math.max(0, Math.round(len * rate)));
  const attack = Math.max(MIN_RAMP_S, Math.min(p.attack, len / 3));
  const decay = Math.max(MIN_RAMP_S, Math.min(p.decay, len - attack));
  const punch = p.punch ?? 0;
  const duty = p.duty ?? 0.5;
  const nyq = rate / 2;
  const lpA = p.lowpass ? 1 - Math.exp((-2 * Math.PI * Math.min(p.lowpass, nyq * 0.95)) / rate) : 1;
  const hpA = p.highpass ? Math.exp((-2 * Math.PI * Math.min(p.highpass, nyq * 0.95)) / rate) : 0;
  let phase = 0;
  let lp = 0;
  let hpOut = 0;
  let hpPrevIn = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const vib = p.vibratoHz && p.vibratoDepth ? 1 + p.vibratoDepth * Math.sin(2 * Math.PI * p.vibratoHz * t) : 1;
    const f = Math.max(0, (freq0 + (p.slide ?? 0) * t) * vib);
    phase += f / rate;
    phase -= Math.floor(phase);
    let s: number;
    switch (p.wave) {
      case 'square': s = phase < duty ? 1 : -1; break;
      case 'saw': s = 2 * phase - 1; break;
      case 'triangle': s = 4 * Math.abs(phase - 0.5) - 1; break;
      case 'sine': s = Math.sin(2 * Math.PI * phase); break;
      default: s = rnd() * 2 - 1;
    }
    if (p.lowpass) {
      lp += lpA * (s - lp);
      s = lp;
    }
    if (p.highpass) {
      hpOut = hpA * (hpOut + s - hpPrevIn);
      hpPrevIn = s;
      s = hpOut;
    }
    let env: number;
    if (t < attack) env = t / attack;
    else if (t > len - decay) env = Math.max(0, (len - t) / decay);
    else env = 1;
    // Punch: a soft boost over the first part of the sustain.
    const boost = 1 + punch * Math.exp(-(t - attack) * 14) * (t >= attack ? 1 : 0);
    out[start + i] = (out[start + i] ?? 0) + s * env * boost;
  }
}

/** Renders one effect to mono samples. Length = attack + sustain + decay (or the notes' end); peak <= `gain`. */
export function renderSfx(p: SfxParams, sampleRate: number): Float32Array {
  const rnd = mulberry32(p.seed ?? 1);
  const notes = p.notes && p.notes.length > 0 ? p.notes : null;
  const total = notes ? Math.max(...notes.map((n) => n.at + n.len)) : p.attack + p.sustain + p.decay;
  const length = Number.isFinite(total) && total > 0 ? Math.round(total * sampleRate) : 0;
  const out = new Float32Array(length);
  if (length === 0) return out;
  if (notes) {
    for (const note of notes) oneVoice(p, note.len, note.freq, sampleRate, rnd, out, Math.max(0, Math.round(note.at * sampleRate)));
  } else {
    oneVoice(p, total, p.freq, sampleRate, rnd, out, 0);
  }
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const v = out[i] ?? 0;
    if (!Number.isFinite(v)) out[i] = 0;
    else peak = Math.max(peak, Math.abs(v));
  }
  const gain = Math.max(0, Math.min(1, p.gain));
  if (peak > 0) {
    const k = gain / peak;
    for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) * k;
  }
  return out;
}
