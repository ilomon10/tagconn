// STUB (W0b): W1-5 owns the presets. Every id maps to one blank preset.
import { SFX_IDS, type SfxId } from '../../game/sfxBus';
import type { SfxParams } from './types';

const BLANK: SfxParams = { wave: 'sine', attack: 0, sustain: 0, decay: 0, freq: 440, gain: 0 };

export const SFX_PRESETS: Record<SfxId, SfxParams> = Object.fromEntries(SFX_IDS.map((id) => [id, BLANK])) as Record<SfxId, SfxParams>;
