import { useDisplayPrefsStore } from '../../stores/displayPrefsStore';
import { useOfficeStore } from '../../stores/officeStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { hostLocalHour, normalizeHour, type ClockSync } from '../../game/lighting/clock';
import { LIGHTING_DEFAULTS } from '../../game/lighting/palette';
import { sunAt } from '../../game/lighting/sun';
import type { SunPhase } from '../../game/lighting/types';

/** M16 time-of-day row (docs/design/lighting.md section 4): this browser's sun override over the office clock (ADR #25 pattern). */

const PHASE_WORD: Record<SunPhase, string> = { night: 'night', dawn: 'dawn', day: 'daytime', dusk: 'dusk' };
// Only the phase is read here, so the colours are irrelevant; any complete set will do.
const STUB_COLOURS = { dayTint: 0, nightTint: 0, nightAlpha: 0, glowAtNight: false, ...LIGHTING_DEFAULTS['modern']! };

/** "14:30" from a decimal hour; rolls minutes up so 14.999 reads 15:00, never 14:60. */
export function formatHour(hour: number): string {
  const total = Math.round(normalizeHour(hour) * 60) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function phaseLabel(hour: number, sun: { dawnHour: number; duskHour: number; twilightHours: number; nightAmbient: number }): string {
  return PHASE_WORD[sunAt(hour, sun, STUB_COLOURS).phase];
}

/** "UTC+7", "UTC-3:30", "UTC": the fallback when the host sent no zone name. */
export function formatOffset(tzOffsetMin: number): string {
  if (!Number.isFinite(tzOffsetMin) || tzOffsetMin === 0) return 'UTC';
  const a = Math.abs(Math.round(tzOffsetMin));
  const m = a % 60;
  return `UTC${tzOffsetMin < 0 ? '-' : '+'}${Math.floor(a / 60)}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** The host zone as display text; `undefined` before the first sync. Render as React text only. */
export function hostZoneLabel(sync: ClockSync | undefined): string | undefined {
  if (!sync) return undefined;
  return sync.tz ? sync.tz : formatOffset(sync.tzOffsetMin);
}

export function useLightingPrefs() {
  const hour = useDisplayPrefsStore((s) => s.lightingHour);
  const setLightingHour = useDisplayPrefsStore((s) => s.setLightingHour);
  const sync = useOfficeStore((s) => s.clockSync);
  const sun = useSettingsStore((s) => s.settings.office.lighting);

  const hostHour = (): number => (sync ? hostLocalHour(sync) : new Date().getHours() + new Date().getMinutes() / 60);
  const shown = hour ?? hostHour();
  return {
    following: hour === null,
    hour: shown,
    label: formatHour(shown),
    phase: phaseLabel(shown, sun),
    zone: hostZoneLabel(sync),
    setHour: (h: number) => setLightingHour(h),
    /** Pins the slider to the host's current hour and keeps the override. */
    now: () => setLightingHour(Math.round(hostHour() * 4) / 4),
    follow: () => setLightingHour(null),
  };
}
