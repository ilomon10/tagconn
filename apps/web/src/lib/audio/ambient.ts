// M13 W1-5: ambient beds built from Web Audio graphs (docs/design/office-life.md 3.7.2). No timers: sparse events
// (keyboard ticks, chirps, crackle) are baked into short looping buffers.
import type { AmbientContext } from '../../game/sfxBus';
import { mulberry32 } from './sfxr';
import type { AmbientKind } from './types';

// Level: the ONE 0.25 attenuation (relative to master) lives on the engine's ambient bus; this inner bus ramps 0..1.
const FADE_S = 1.5;
const STOP_FADE_S = 0.6;

export function ambientFor(style: AmbientContext['style'], night: boolean): AmbientKind {
  if (style === 'rift') return 'rift';
  if (style === 'guild') return night ? 'tavern-night' : 'tavern-day';
  return night ? 'office-night' : 'office-day';
}

function makeBuffer(ctx: BaseAudioContext, seconds: number, fill: (d: Float32Array, rate: number) => void): AudioBuffer {
  const rate = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.max(1, Math.round(seconds * rate)), rate);
  fill(buf.getChannelData(0), rate);
  return buf;
}

/** Brown noise (integrated white noise), normalised to about +-0.5. */
function brown(d: Float32Array, seed: number, level: number): void {
  const rnd = mulberry32(seed);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    last = (last + 0.02 * (rnd() * 2 - 1)) / 1.02;
    d[i] = last * 3.5 * level;
  }
}

/** Adds a short enveloped burst (`f` = 0 for noise) at `at` seconds, looping-safe. */
function burst(d: Float32Array, rate: number, at: number, len: number, f: number, amp: number, rnd: () => number): void {
  const start = Math.round(at * rate);
  const n = Math.round(len * rate);
  for (let i = 0; i < n && start + i < d.length; i++) {
    const t = i / n;
    const env = Math.sin(Math.PI * Math.min(1, t * 1.0)) ** 2;
    const s = f > 0 ? Math.sin(2 * Math.PI * f * (i / rate)) : rnd() * 2 - 1;
    d[start + i] = (d[start + i] ?? 0) + s * env * amp;
  }
}

export function createAmbient(ctx: BaseAudioContext, kind: AmbientKind, out: AudioNode): { stop(): void } {
  const nodes: AudioNode[] = [];
  const sources: (AudioScheduledSourceNode)[] = [];
  const track = <T extends AudioNode>(n: T): T => {
    nodes.push(n);
    return n;
  };
  const bus = track(ctx.createGain());
  const now = ctx.currentTime;
  bus.gain.setValueAtTime(0, now);
  bus.gain.linearRampToValueAtTime(1, now + FADE_S);
  bus.connect(out);

  const loop = (buf: AudioBuffer, ...chain: AudioNode[]): void => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    sources.push(src);
    let prev: AudioNode = track(src);
    for (const n of chain) {
      prev.connect(track(n));
      prev = n;
    }
    prev.connect(bus);
  };
  const filter = (type: BiquadFilterType, f: number, q = 0.7): BiquadFilterNode => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  };
  const gain = (v: number): GainNode => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };

  switch (kind) {
    case 'office-day': {
      loop(makeBuffer(ctx, 4, (d) => brown(d, 101, 0.6)), filter('lowpass', 420), gain(0.8));
      loop(makeBuffer(ctx, 9, (d, rate) => {
        const rnd = mulberry32(5);
        for (const at of [0.7, 1.1, 1.3, 3.4, 3.6, 6.2, 6.35, 6.5, 8.1]) burst(d, rate, at, 0.012, 0, 0.3, rnd);
      }), filter('bandpass', 2600, 1.2), gain(0.5));
      break;
    }
    case 'office-night': {
      loop(makeBuffer(ctx, 4, (d) => brown(d, 102, 0.3)), filter('lowpass', 300), gain(0.5));
      loop(makeBuffer(ctx, 7, (d, rate) => {
        const rnd = mulberry32(6);
        for (const base of [0.5, 3.2, 5.1]) for (let k = 0; k < 3; k++) burst(d, rate, base + k * 0.09, 0.05, 4300, 0.25, rnd);
      }), filter('lowpass', 5000), gain(0.4));
      break;
    }
    case 'tavern-day':
    case 'tavern-night': {
      const day = kind === 'tavern-day';
      loop(makeBuffer(ctx, 5, (d) => {
        const rnd = mulberry32(103);
        for (let i = 0; i < d.length; i++) d[i] = (rnd() * 2 - 1) * 0.5;
      }), filter('bandpass', day ? 500 : 380, 0.9), gain(day ? 0.7 : 0.4));
      loop(makeBuffer(ctx, 6, (d, rate) => {
        const rnd = mulberry32(8);
        for (let k = 0; k < 14; k++) burst(d, rate, rnd() * 5.8, 0.006 + rnd() * 0.01, 0, 0.3 + rnd() * 0.3, rnd);
      }), filter('highpass', 1200), gain(0.45));
      break;
    }
    case 'rift': {
      // The LFO modulates its own swell gain (0.85 +- 0.15), not bus.gain, so the stop fade reaches true silence.
      const swell = track(ctx.createGain());
      swell.gain.value = 0.85;
      swell.connect(bus);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.12;
      const lfoDepth = track(ctx.createGain());
      lfoDepth.gain.value = 0.15;
      track(lfo).connect(lfoDepth);
      lfoDepth.connect(swell.gain);
      sources.push(lfo);
      for (const f of [55, 55.7, 82.4, 110.9]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        const g = track(ctx.createGain());
        g.gain.value = 0.35;
        track(o).connect(g);
        g.connect(swell);
        sources.push(o);
      }
      break;
    }
  }
  for (const s of sources) s.start();

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      // Fade out, stop the sources once silent, then disconnect.
      const t = ctx.currentTime;
      bus.gain.cancelScheduledValues(t);
      bus.gain.setValueAtTime(bus.gain.value, t);
      bus.gain.linearRampToValueAtTime(0, t + STOP_FADE_S);
      for (const s of sources) {
        try {
          s.stop(t + STOP_FADE_S);
        } catch {
          /* never started or already stopped */
        }
      }
      setTimeout(() => {
        for (const n of nodes) n.disconnect();
      }, (STOP_FADE_S + 0.1) * 1000);
    },
  };
}
