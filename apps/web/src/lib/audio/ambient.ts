// STUB (W0b): W1-5 owns the ambient beds.
import type { AmbientContext } from '../../game/sfxBus';
import type { AmbientKind } from './types';

export function ambientFor(_style: AmbientContext['style'], _night: boolean): AmbientKind {
  return 'office-day';
}

export function createAmbient(_ctx: BaseAudioContext, _kind: AmbientKind, _out: AudioNode): { stop(): void } {
  return { stop() {} };
}
