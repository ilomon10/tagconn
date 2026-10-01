import { sfxBus } from '../../../game/sfxBus';
import { useAudioPrefsStore } from '../../../stores/audioPrefsStore';
import { useSettingsStore } from '../../../stores/settingsStore';
import { cx } from '../../../components/ui';

/** Menu sheet row: speaker toggle, volume, "Use server default". The clicks are the gesture that unlocks audio. */
export function SoundRow() {
  const office = useSettingsStore((s) => s.settings.office);
  const muted = useAudioPrefsStore((s) => s.muted);
  const volume = useAudioPrefsStore((s) => s.volume);
  const setMuted = useAudioPrefsStore((s) => s.setMuted);
  const setVolume = useAudioPrefsStore((s) => s.setVolume);
  const reset = useAudioPrefsStore((s) => s.reset);

  const isMuted = muted ?? !office.sound;
  const shown = volume ?? office.audio.volume;
  const pct = Math.round(shown * 100);
  const click = (): void => sfxBus.emit({ id: 'ui-click' });

  return (
    <div className="rounded-lg px-2.5 py-1.5">
      <div className="flex min-h-11 items-center gap-3 coarse:min-h-0">
        <button
          type="button"
          aria-pressed={!isMuted}
          onClick={() => {
            setMuted(!isMuted);
            click();
          }}
          className="flex min-h-11 flex-1 items-center gap-3 text-left"
        >
          <span aria-hidden="true">{isMuted ? '🔇' : '🔊'}</span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink-100">Sound</span>
            <span className="block truncate text-[11px] text-ink-400">{isMuted ? 'Muted' : `On, ${pct}%`}</span>
          </span>
          <span className={cx('relative h-5 w-9 shrink-0 rounded-full transition-colors', !isMuted ? 'bg-cozy' : 'bg-ink-600')} aria-hidden="true">
            <span className={cx('absolute left-0.5 top-0.5 size-4 rounded-full bg-ink-100 transition-transform', !isMuted && 'translate-x-4')} />
          </span>
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={pct}
          aria-label="Volume"
          aria-valuetext={`${pct}%`}
          onChange={(e) => setVolume(Number(e.target.value) / 100)}
          onPointerUp={click}
          className="min-h-8 flex-1 accent-cozy coarse:min-h-11"
        />
        <button
          type="button"
          onClick={() => {
            reset();
            click();
          }}
          className="min-h-8 rounded-md px-2 text-[11px] text-ink-400 hover:text-ink-100 coarse:min-h-11"
          title="Use the server's sound settings"
        >
          Use server default
        </button>
      </div>
    </div>
  );
}
