// M16: host clock sync, cycle resolution and the sun step (docs/design/lighting.md sections 1.3-1.4). Pure, no Phaser, no Date
// except through the `now` parameters. Every modulo is positive and every non-finite input degrades to noon.
import { HostClockSchema, type HostClock, type Settings } from '@tagconn/shared';

export type LightingSettings = Settings['office']['lighting'];
export type ThemeMode = Settings['office']['theme'];

/** The per-browser override (displayPrefsStore, ADR #25 pattern): `null` = follow the server. */
export interface LightingOverride {
  hour: number;
}

export interface ResolvedCycle {
  cycle: 'host-clock' | 'fixed' | 'accelerated';
  fixedHour: number;
  cycleMinutes: number;
  source: 'override' | 'theme' | 'settings';
}

export interface ClockSync {
  skewMs: number;
  tzOffsetMin: number;
  tz?: string;
  measuredAt: number;
}

/** Never re-bake the lightmap more than once per this many ms (bake-storm guard, threat check #3). */
export const MIN_BAKE_INTERVAL_MS = 500;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Positive modulo; non-finite input yields `fallback`. */
export function posMod(t: number, d: number, fallback = 0): number {
  if (!Number.isFinite(t)) return fallback;
  const r = ((t % d) + d) % d;
  return Number.isFinite(r) ? r : fallback;
}

/** An hour into [0, 24) (24 -> 0); non-finite -> 12. */
export const normalizeHour = (h: number): number => posMod(h, 24, 12);

/** Precedence: override (hour slider) -> `office.theme` day/night (fixed 13:00 / 01:00) -> `office.lighting`. `auto` defers to the settings. */
export function resolveCycle(theme: ThemeMode, lighting: LightingSettings, override: LightingOverride | null): ResolvedCycle {
  const cycleMinutes = lighting.cycleMinutes;
  if (override) return { cycle: 'fixed', fixedHour: normalizeHour(override.hour), cycleMinutes, source: 'override' };
  if (theme === 'day') return { cycle: 'fixed', fixedHour: 13, cycleMinutes, source: 'theme' };
  if (theme === 'night') return { cycle: 'fixed', fixedHour: 1, cycleMinutes, source: 'theme' };
  return { cycle: lighting.cycle, fixedHour: normalizeHour(lighting.fixedHour), cycleMinutes, source: 'settings' };
}

/** One-shot sync from a snapshot: skew = serverNow - midpoint of the ack round trip. An absent or invalid `clock` means skew 0 and the browser's zone. */
export function syncClock(
  clock: HostClock | undefined,
  sentAt: number,
  receivedAt: number,
  browserTzOffsetMin = -new Date().getTimezoneOffset(),
): ClockSync {
  const parsed = HostClockSchema.safeParse(clock);
  const measuredAt = Number.isFinite(receivedAt) ? receivedAt : 0;
  if (!parsed.success) return { skewMs: 0, tzOffsetMin: browserTzOffsetMin, measuredAt };
  const c = parsed.data;
  const mid = (sentAt + receivedAt) / 2;
  const skewMs = Number.isFinite(mid) ? c.serverNow - mid : 0;
  const sync: ClockSync = { skewMs, tzOffsetMin: c.tzOffsetMin, measuredAt };
  if (c.tz !== undefined) sync.tz = c.tz;
  return sync;
}

/** Host epoch ms now. */
export const hostNow = (sync: ClockSync, now = Date.now()): number => now + sync.skewMs;

/** Host local decimal hour in [0, 24), via UTC arithmetic so the browser zone never leaks in. Non-finite -> 12. */
export function hostLocalHour(sync: ClockSync, now = Date.now()): number {
  const h = posMod(hostNow(sync, now) + sync.tzOffsetMin * 60_000, DAY_MS, Number.NaN) / HOUR_MS;
  return Number.isFinite(h) && h < 24 ? h : Number.isFinite(h) ? 0 : 12;
}

/** The hour the sun uses: host-clock -> host local hour; fixed -> fixedHour; accelerated -> fixedHour + 24 * elapsed / cycleMinutes (mod 24). */
export function cycleHour(cycle: ResolvedCycle, sync: ClockSync, now: number, epochMs: number): number {
  if (cycle.cycle === 'host-clock') return hostLocalHour(sync, now);
  const base = normalizeHour(cycle.fixedHour);
  if (cycle.cycle === 'fixed') return base;
  const elapsedMin = (now - epochMs) / 60_000;
  if (!(cycle.cycleMinutes > 0)) return base;
  return normalizeHour(base + (24 * elapsedMin) / cycle.cycleMinutes);
}

/** Integer step index; the lightmap re-bakes when it changes (compare for equality only, never iterate between steps). */
export const sunStep = (hour: number, stepMinutes: number): number => Math.floor((hour * 60) / stepMinutes);

/** Step the controller actually uses: accelerated days are floored so the bake rate stays near 2/s at most. */
export function effectiveSunStep(lighting: Pick<LightingSettings, 'cycle' | 'cycleMinutes' | 'sunStepMinutes'>): number {
  if (lighting.cycle !== 'accelerated') return lighting.sunStepMinutes;
  return Math.max(lighting.sunStepMinutes, Math.ceil(12 / lighting.cycleMinutes));
}
