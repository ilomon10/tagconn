// STUB (W0b): W1-6 owns the engine. The inert engine never makes a sound.
import type { AudioEngine } from './types';

const inert = (): AudioEngine => ({
  unlocked: false,
  setMix() {},
  play() {},
  setAmbient() {},
  destroy() {},
});

export function getAudioEngine(): AudioEngine {
  return inert();
}

export function createAudioEngine(_deps: { createContext: () => AudioContext | null; target: EventTarget }): AudioEngine {
  return inert();
}
