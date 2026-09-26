// apps/web/src/game/postfx/quality.ts  (M8 8o.3: `quality: 'auto'` frame-time measurement)
//
// Pure sampling/decision logic for `office.shaders.quality === 'auto'`: measure frame time for
// ~2s, then drop to `'low'` if too many frames blew the budget. No Phaser, no timers — the caller
// (`PostFxController`) feeds it `delta` from the scene's own `update(time, delta)`.

/** How long to sample before committing to a quality tier. */
export const AUTO_QUALITY_WINDOW_MS = 2000;

/** A frame slower than this (~45fps) counts as "over budget". */
export const AUTO_QUALITY_FRAME_BUDGET_MS = 1000 / 45;

/** Drop to `'low'` once more than this fraction of sampled frames were over budget. */
export const AUTO_QUALITY_OVER_BUDGET_RATIO = 0.35;

/** Light sprite caps per resolved quality tier (requirement 8o.3's "'low' also caps light sprites
 *  (e.g. 48)"). */
export const LOW_QUALITY_MAX_LIGHTS = 48;
export const HIGH_QUALITY_MAX_LIGHTS = 160;

export interface AutoQualityState {
  elapsedMs: number;
  frames: number;
  overBudgetFrames: number;
}

export function createAutoQualityState(): AutoQualityState {
  return { elapsedMs: 0, frames: 0, overBudgetFrames: 0 };
}

/** Folds one frame's `deltaMs` into the sampling window. Pure — returns a new state. */
export function sampleAutoQuality(state: AutoQualityState, deltaMs: number): AutoQualityState {
  return {
    elapsedMs: state.elapsedMs + deltaMs,
    frames: state.frames + 1,
    overBudgetFrames: state.overBudgetFrames + (deltaMs > AUTO_QUALITY_FRAME_BUDGET_MS ? 1 : 0),
  };
}

/** `null` while still inside the measurement window (or before any frame has been sampled);
 *  otherwise the tier the window's frame times settled on. Once resolved the caller should stop
 *  sampling and keep the decision (re-measuring only if the user later switches back to `'auto'`). */
export function resolveAutoQuality(state: AutoQualityState): 'low' | 'high' | null {
  if (state.frames === 0 || state.elapsedMs < AUTO_QUALITY_WINDOW_MS) return null;
  const overRatio = state.overBudgetFrames / state.frames;
  return overRatio > AUTO_QUALITY_OVER_BUDGET_RATIO ? 'low' : 'high';
}

/** `configured` is `office.shaders.quality`; `measured` is `resolveAutoQuality`'s last result
 *  (`null` while `'auto'` is still measuring, in which case this optimistically renders at
 *  `'high'` until the window closes rather than flashing `'low'` first). */
export function effectiveQuality(configured: 'auto' | 'low' | 'high', measured: 'low' | 'high' | null): 'low' | 'high' {
  if (configured !== 'auto') return configured;
  return measured ?? 'high';
}

export function maxLightsForQuality(quality: 'low' | 'high'): number {
  return quality === 'low' ? LOW_QUALITY_MAX_LIGHTS : HIGH_QUALITY_MAX_LIGHTS;
}
