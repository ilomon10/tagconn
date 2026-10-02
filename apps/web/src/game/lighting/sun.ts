// M16: the stylised sun (docs/design/lighting.md section 2.2). Pure. Every output is clamped to its range; degenerate
// params or a non-finite hour yield the noon state.
import type { Point } from '../procgen/types';
import type { LightingColours } from './palette';
import { posMod } from './clock';
import type { SunPhase, SunState } from './types';

export type { SunPhase, SunState };

export interface SunParams {
  dawnHour: number;
  duskHour: number;
  twilightHours: number;
  nightAmbient: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const smooth = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

const mixColour = (a: number, b: number, t: number): number => {
  const u = clamp01(t);
  const ch = (s: number): number => Math.round(((a >> s) & 0xff) * (1 - u) + ((b >> s) & 0xff) * u);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

/** 0.4..1 slow moon phase factor from a day index. */
export function moonPhase(dayIndex: number): number {
  const d = Number.isFinite(dayIndex) ? dayIndex : 0;
  return 0.4 + 0.6 * (0.5 + 0.5 * Math.cos((2 * Math.PI * d) / 29.53));
}

function noonState(p: SunParams, colours: LightingColours): SunState {
  const na = Number.isFinite(p.nightAmbient) ? clamp01(p.nightAmbient) : 0.35;
  return { hour: 12, phase: 'day', daylight: 1, elevation: 1, skew: 0, moon: 0, ambient: clamp01(na + (1 - na)), tint: mixColour(colours.moonTint, 0xffffff, 1) };
}

export function sunAt(hour: number, p: SunParams, colours: LightingColours, dayIndex = 0): SunState {
  if (!Number.isFinite(hour) || !Number.isFinite(p.dawnHour) || !Number.isFinite(p.duskHour) || !Number.isFinite(p.twilightHours)) {
    return noonState(p, colours);
  }
  const h = posMod(hour, 24, 12);
  const span = p.duskHour - p.dawnHour;
  if (!(span > 0)) return noonState(p, colours);
  const tw = Math.max(1e-6, Math.min(p.twilightHours, span / 2));
  const na = Number.isFinite(p.nightAmbient) ? clamp01(p.nightAmbient) : 0.35;

  // t = hours since the dawn centre, in [-tw/2, 24 - tw/2); the dusk centre sits at t = span. A second sample one day later
  // keeps the ramps continuous when dusk reaches 24 or dawn is 0 (ramps that straddle midnight).
  const t = posMod(h - p.dawnHour + tw / 2, 24) - tw / 2;
  const upAt = (x: number): number => smooth((x + tw / 2) / tw);
  const downAt = (x: number): number => 1 - smooth((x - span + tw / 2) / tw);
  const up = upAt(t);
  const duskT = Math.abs(t - span) <= Math.abs(t + 24 - span) ? t : t + 24;
  const down = downAt(duskT);
  const daylight = clamp01(Math.max(upAt(t) * downAt(t), upAt(t + 24) * downAt(t + 24)));

  const inDawn = Math.abs(t) < tw / 2;
  const inDusk = Math.abs(duskT - span) < tw / 2;
  const phase: SunPhase = inDawn ? 'dawn' : inDusk ? 'dusk' : daylight >= 0.5 ? 'day' : 'night';

  const frac = clamp01((h - p.dawnHour) / span);
  const elevation = clamp01(Math.sin(Math.PI * frac)) * (daylight > 0 ? 1 : 0);
  const skew = Math.max(-1, Math.min(1, -Math.cos(Math.PI * frac))) + 0;
  const moon = clamp01((1 - daylight) * moonPhase(dayIndex));
  const ambient = clamp01(na + (1 - na) * daylight);

  let tint = mixColour(colours.moonTint, 0xffffff, daylight);
  if (inDawn) tint = mixColour(tint, colours.dawnTint, 1 - Math.abs(2 * up - 1));
  else if (inDusk) tint = mixColour(tint, colours.duskTint, 1 - Math.abs(2 * (1 - down) - 1));

  const out: SunState = { hour: h, phase, daylight, elevation, skew, moon, ambient, tint };
  const finite = [h, daylight, elevation, skew, moon, ambient, tint].every(Number.isFinite);
  return finite ? out : noonState(p, colours);
}

/** Day shadow direction for a column of `heightPx`: `{ dx: -skew * len, dy: len }`, len = height * (0.35 + 0.9 * (1 - elevation)) faded by daylight, clamped to 2 T. Zero at night. */
export function sunShadowVector(sun: SunState, heightPx: number, T: number): Point {
  if (!(sun.daylight > 0) || !(heightPx > 0) || !(T > 0)) return { x: 0, y: 0 };
  const len = Math.min(heightPx * (0.35 + 0.9 * (1 - sun.elevation)) * sun.daylight, 2 * T);
  return { x: -sun.skew * len + 0, y: len };
}
