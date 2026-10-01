import { useEffect, useRef } from 'react';
import { sfxBus, type AmbientContext, type MusicRequest } from '../../../game/sfxBus';
import { getAudioEngine } from '../../../lib/audio/engine';
import { ambientFor } from '../../../lib/audio/ambient';
import { dayNightChanged, resolveMix } from '../../../lib/audio/mix';
import { installUiSoundDelegate } from '../../../lib/audio/uiSound';
import { spatialGain, spatialPan } from '../../../lib/audio/spatial';
import type { AudioMix } from '../../../lib/audio/types';
import { useAudioPrefsStore } from '../../../stores/audioPrefsStore';
import { useSettingsStore } from '../../../stores/settingsStore';

/**
 * Connects the sfx bus to the audio engine (docs/design/office-life.md 3.7.2). `active` is false on a
 * non-office tab (master 0). Mix changes follow settings, this browser's prefs and tab visibility.
 */
export function useAudioBridge(active: boolean): void {
  // Generic button/switch/tab clicks and party/menu hovers (`data-sfx`, `data-sfx-hover`; see uiSound.ts).
  useEffect(() => installUiSoundDelegate(), []);
  const lastAmbient = useRef<AmbientContext | null>(null);

  const office = useSettingsStore((s) => s.settings.office);
  const muted = useAudioPrefsStore((s) => s.muted);
  const volume = useAudioPrefsStore((s) => s.volume);
  const battleMusic = useSettingsStore((s) => s.settings.battle.music);

  useEffect(() => {
    const engine = getAudioEngine();
    let mix: AudioMix = resolveMix(office, { muted, volume }, document.hidden);
    const apply = (): void => {
      mix = resolveMix(office, { muted, volume }, document.hidden);
      engine.setMix(active ? mix : { ...mix, master: 0 });
    };
    apply();

    const offSfx = sfxBus.on((e) => {
      const l = sfxBus.listener();
      let gain = e.gain ?? 1;
      let pan: number | undefined;
      if (e.at && l) {
        const g = spatialGain(e.at, l);
        if (g <= 0) return;
        gain *= g;
        pan = spatialPan(e.at, l);
      }
      engine.play(e.id, pan === undefined ? { gain } : { gain, pan });
    });
    const offAmbient = sfxBus.onAmbient((a) => {
      if (dayNightChanged(lastAmbient.current, a)) sfxBus.emit({ id: 'transition-daynight' });
      lastAmbient.current = a;
      engine.setAmbient(mix.ambient ? ambientFor(a.style, a.night) : null);
    });
    // Re-evaluate the ambient bed after a mix change (the bus replays the last context to this subscriber only).
    const ambient = sfxBus.ambient();
    if (ambient) engine.setAmbient(mix.ambient ? ambientFor(ambient.style, ambient.night) : null);

    // Battle music (replayed to this subscriber); gated by `battle.music` and master here, by sfx/unlock in the engine.
    const applyMusic = (m: MusicRequest | null): void => {
      if (m && battleMusic && mix.master > 0) engine.setMusic(m.style, m.fadeMs);
      else engine.setMusic(null);
    };
    const offMusic = sfxBus.onMusic(applyMusic);
    if (!sfxBus.music()) engine.setMusic(null);

    document.addEventListener('visibilitychange', apply);
    return () => {
      document.removeEventListener('visibilitychange', apply);
      offSfx();
      offAmbient();
      offMusic();
    };
  }, [office, muted, volume, active, battleMusic]);
}
