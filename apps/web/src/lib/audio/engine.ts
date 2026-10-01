// Web Audio engine (docs/design/office-life.md 3.7.2). Pure of Phaser; the AudioContext is injected for tests.
import type { SfxId } from '../../game/sfxBus';
import { SFX_CATEGORY } from '../../game/sfxBus';
import { createAmbient } from './ambient';
import { createMusic } from './music';
import { SFX_PRESETS } from './presets';
import { renderSfx } from './sfxr';
import type { AmbientKind, AudioEngine, AudioMix, MusicStyle } from './types';

export const MAX_VOICES = 8;
const DEFAULT_MIN_INTERVAL_MS = 60;
const MIN_INTERVAL_MS: Partial<Record<SfxId, number>> = { footstep: 250, typing: 150, 'ui-hover': 120 };
/** Voices kept free for alerts and ui; footsteps and other sfx can only use MAX_VOICES - PRIORITY_RESERVE. */
const PRIORITY_RESERVE = 2;
const MASTER_FADE_S = 0.1;
/** Ambient level relative to master: the only 0.25 stage (ambient.ts ramps its own bus 0..1). */
const AMBIENT_GAIN = 0.25;

/** Battle music level relative to master, and the share of the ambient bed that stays audible underneath it. */
const MUSIC_GAIN = 0.3;
const AMBIENT_DUCK = 0.3;
const DEFAULT_MUSIC_FADE_MS = 400;

const OFF: AudioMix = { master: 0, sfx: false, ambient: false, alerts: false, footsteps: false };

export function createAudioEngine(deps: { createContext: () => AudioContext | null; target: EventTarget }): AudioEngine {
  let ctx: AudioContext | null = null;
  try {
    ctx = deps.createContext();
  } catch {
    ctx = null;
  }
  if (!ctx) return { unlocked: false, setMix() {}, play() {}, setAmbient() {}, setMusic() {}, destroy() {} };
  const c = ctx;

  const masterGain = c.createGain();
  masterGain.connect(c.destination);
  const sfxBus = c.createGain();
  sfxBus.connect(masterGain);
  const ambientBus = c.createGain();
  ambientBus.gain.value = AMBIENT_GAIN;
  ambientBus.connect(masterGain);
  const musicBus = c.createGain();
  musicBus.gain.value = MUSIC_GAIN;
  musicBus.connect(masterGain);

  let mix: AudioMix = OFF;
  let unlocked = false;
  let destroyed = false;
  let voices = 0;
  const live: { cat: string; src: AudioBufferSourceNode }[] = [];
  let suspendTimer: ReturnType<typeof setTimeout> | null = null;
  let wantedAmbient: AmbientKind | null = null;
  let ambient: { kind: AmbientKind; stop(): void } | null = null;
  let wantedMusic: { style: MusicStyle; fadeMs: number } | null = null;
  let music: { style: MusicStyle; stop(fadeMs: number): void } | null = null;
  const buffers = new Map<SfxId, AudioBuffer | null>();
  const lastAt = new Map<SfxId, number>();

  const bufferFor = (id: SfxId): AudioBuffer | null => {
    if (buffers.has(id)) return buffers.get(id) ?? null;
    let buf: AudioBuffer | null = null;
    const data = renderSfx(SFX_PRESETS[id], c.sampleRate);
    if (data.length > 0) {
      buf = c.createBuffer(1, data.length, c.sampleRate);
      buf.getChannelData(0).set(data);
    }
    buffers.set(id, buf);
    return buf;
  };

  const syncAmbient = (): void => {
    const kind = mix.ambient && mix.master > 0 && unlocked ? wantedAmbient : null;
    if (ambient && ambient.kind === kind) return;
    ambient?.stop(); // fades out while the new bed fades in (crossfade)
    ambient = null;
    if (kind) ambient = { kind, ...createAmbient(c, kind, ambientBus) };
  };

  // Plays only while master, sfx and the unlock allow it (like ambient); the ambient bed ducks underneath.
  const syncMusic = (): void => {
    const want = mix.sfx && mix.master > 0 && unlocked ? wantedMusic : null;
    const fadeMs = wantedMusic?.fadeMs ?? DEFAULT_MUSIC_FADE_MS;
    if (!(music && want && music.style === want.style)) {
      music?.stop(fadeMs);
      music = null;
      if (want) music = { style: want.style, ...createMusic(c, want.style, musicBus, want.fadeMs) };
    }
    const t = c.currentTime;
    ambientBus.gain.cancelScheduledValues(t);
    ambientBus.gain.setValueAtTime(ambientBus.gain.value, t);
    ambientBus.gain.linearRampToValueAtTime(music ? AMBIENT_GAIN * AMBIENT_DUCK : AMBIENT_GAIN, t + fadeMs / 1000);
  };

  const syncContext = (): void => {
    if (destroyed) return;
    if (suspendTimer) clearTimeout(suspendTimer);
    suspendTimer = null;
    if (!unlocked) {
      masterGain.gain.value = mix.master;
      return;
    }
    syncAmbient();
    syncMusic();
    if (mix.master === 0) {
      // Ramp down first so suspending does not click; the ambient bed fades out meanwhile.
      const t = c.currentTime;
      masterGain.gain.cancelScheduledValues(t);
      masterGain.gain.setValueAtTime(masterGain.gain.value, t);
      masterGain.gain.linearRampToValueAtTime(0, t + MASTER_FADE_S);
      suspendTimer = setTimeout(() => {
        suspendTimer = null;
        if (!destroyed) void c.suspend?.().catch?.(() => {});
      }, MASTER_FADE_S * 1000 + 700);
    } else {
      masterGain.gain.cancelScheduledValues(c.currentTime);
      masterGain.gain.value = mix.master;
      void c.resume?.().catch?.(() => {});
    }
  };

  const unlock = (): void => {
    if (unlocked || destroyed) return;
    unlocked = true;
    off();
    syncContext();
  };
  const off = (): void => {
    deps.target.removeEventListener('pointerdown', unlock);
    deps.target.removeEventListener('keydown', unlock);
  };
  deps.target.addEventListener('pointerdown', unlock);
  deps.target.addEventListener('keydown', unlock);

  return {
    get unlocked() {
      return unlocked;
    },
    setMix(m) {
      mix = m;
      syncContext();
    },
    play(id, opts) {
      if (destroyed || !unlocked || mix.master <= 0) return;
      const cat = SFX_CATEGORY[id];
      if (!mix[cat === 'ui' ? 'sfx' : cat]) return;
      const priority = cat === 'alerts' || cat === 'ui';
      const now = c.currentTime * 1000;
      const last = lastAt.get(id);
      if (last !== undefined && now - last < (MIN_INTERVAL_MS[id] ?? DEFAULT_MIN_INTERVAL_MS)) return;
      const buf = bufferFor(id);
      if (!buf) return;
      if (voices >= (priority ? MAX_VOICES : MAX_VOICES - PRIORITY_RESERVE)) {
        // Alerts may steal the oldest footsteps-category voice (footstep and typing ticks); everything else is dropped.
        const victim = cat === 'alerts' ? live.find((v) => v.cat === 'footsteps') : undefined;
        if (!victim) return;
        try {
          victim.src.stop();
        } catch {
          /* already stopped */
        }
        victim.src.onended?.(new Event('ended'));
        victim.src.onended = null;
      }
      lastAt.set(id, now);
      const src = c.createBufferSource();
      src.buffer = buf;
      const gain = c.createGain();
      gain.gain.value = Math.min(1, Math.max(0, opts?.gain ?? 1));
      src.connect(gain);
      let tail: AudioNode = gain;
      if (opts?.pan !== undefined && typeof c.createStereoPanner === 'function') {
        const p = c.createStereoPanner();
        p.pan.value = Math.min(1, Math.max(-1, opts.pan));
        gain.connect(p);
        tail = p;
      }
      tail.connect(sfxBus);
      voices++;
      const entry = { cat, src };
      live.push(entry);
      src.onended = () => {
        const i = live.indexOf(entry);
        if (i < 0) return;
        live.splice(i, 1);
        voices = Math.max(0, voices - 1);
        try {
          src.disconnect();
          tail.disconnect();
        } catch {
          /* already disconnected */
        }
      };
      src.start();
    },
    setAmbient(kind) {
      wantedAmbient = kind;
      syncAmbient();
    },
    setMusic(style, fadeMs = DEFAULT_MUSIC_FADE_MS) {
      wantedMusic = style ? { style, fadeMs } : null;
      if (!destroyed) syncMusic();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      off();
      if (suspendTimer) clearTimeout(suspendTimer);
      // The abrupt cut is intentional at teardown: nothing is left to hear, so the ambient fade is skipped.
      ambient?.stop();
      ambient = null;
      music?.stop(0);
      music = null;
      try {
        masterGain.disconnect();
        void c.close?.().catch?.(() => {});
      } catch {
        /* ignore */
      }
    },
  };
}

let shared: AudioEngine | null = null;

/** Lazy browser singleton; inert without `window` or `AudioContext`. */
export function getAudioEngine(): AudioEngine {
  if (!shared) {
    const engine = createAudioEngine({
      createContext: () => {
        if (typeof window === 'undefined') return null;
        const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
        const Ctor = w.AudioContext ?? w.webkitAudioContext;
        return Ctor ? new Ctor() : null;
      },
      target: typeof window === 'undefined' ? new EventTarget() : window,
    });
    const destroy = engine.destroy.bind(engine);
    // Reset the singleton so a later call builds a fresh engine.
    engine.destroy = () => {
      destroy();
      if (shared === engine) shared = null;
    };
    shared = engine;
  }
  return shared;
}
