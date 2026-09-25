/**
 * Pure math for the office camera's "safe region": the part of the canvas that floating React
 * overlays (the agent status panel, a docked toolbar, ...) do not cover. Every function here takes
 * plain numbers so it can be unit tested without Phaser or the DOM.
 */

/** Edge distances (CSS px) that a floating overlay occupies over the canvas. */
export interface SafeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const ZERO_INSETS: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** World-space padding kept beyond the map edges so tiles never sit flush against the safe rect. */
export const SAFE_VIEWPORT_MARGIN = 24;

/** The unobscured rectangle of the camera viewport, in screen px, once `insets` are subtracted. */
export function safeViewportRect(camWidth: number, camHeight: number, insets: SafeInsets): Rect {
  return {
    x: insets.left,
    y: insets.top,
    w: Math.max(1, camWidth - insets.left - insets.right),
    h: Math.max(1, camHeight - insets.top - insets.bottom),
  };
}

export interface SafeBoundsInput {
  camWidth: number;
  camHeight: number;
  zoom: number;
  worldW: number;
  worldH: number;
  insets: SafeInsets;
  margin?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Phaser's `scrollX`/`scrollY` are *not* the world coordinate at the camera's top-left, except at
 * zoom 1. With the default origin (0.5), Phaser's own `Camera#centerOn(x, y)` sets
 * `scrollX = x - camWidth / 2` — no division by zoom at all (see `BaseCamera#centerOnX` and the
 * `midX`/`worldView` math in `Camera#preRender`). Only the *screen-space delta* between a point and
 * the viewport's own center scales with zoom when converting to world units; the `camWidth / 2`
 * term itself never does. This generalizes that to the "safe rect" (the part of the viewport an
 * inset hasn't covered): the world point that lands at the safe rect's center is `scrollX/Y` plus
 * this offset.
 */
function safeCenterOffset(camWidth: number, camHeight: number, zoom: number, insets: SafeInsets): { offsetX: number; offsetY: number } {
  const safe = safeViewportRect(camWidth, camHeight, insets);
  return {
    offsetX: camWidth / 2 + (safe.x + safe.w / 2 - camWidth / 2) / zoom,
    offsetY: camHeight / 2 + (safe.y + safe.h / 2 - camHeight / 2) / zoom,
  };
}

/**
 * Clamp a proposed camera scroll so every point of the map can still be panned into the safe
 * (unobscured) rect — not just the full viewport. This is what lets a tile hidden behind the
 * panel be dragged out from under it. Falls back to centering the world in the safe rect when the
 * map is smaller than it (same trick the old full-viewport clamp used, generalized).
 */
export function clampScrollToSafeBounds(scrollX: number, scrollY: number, input: SafeBoundsInput): { scrollX: number; scrollY: number } {
  const { camWidth, camHeight, zoom, worldW, worldH, insets, margin = SAFE_VIEWPORT_MARGIN } = input;
  const safe = safeViewportRect(camWidth, camHeight, insets);
  const safeWorldW = safe.w / zoom;
  const safeWorldH = safe.h / zoom;
  const { offsetX, offsetY } = safeCenterOffset(camWidth, camHeight, zoom, insets);

  const cx = clamp(scrollX + offsetX, Math.min(safeWorldW / 2 - margin, worldW / 2), Math.max(worldW - safeWorldW / 2 + margin, worldW / 2));
  const cy = clamp(scrollY + offsetY, Math.min(safeWorldH / 2 - margin, worldH / 2), Math.max(worldH - safeWorldH / 2 + margin, worldH / 2));

  return { scrollX: cx - offsetX, scrollY: cy - offsetY };
}

/** The scroll that puts world point (x, y) at the center of the unobscured safe rect. */
export function centerInSafeRect(x: number, y: number, camWidth: number, camHeight: number, zoom: number, insets: SafeInsets): { scrollX: number; scrollY: number } {
  const { offsetX, offsetY } = safeCenterOffset(camWidth, camHeight, zoom, insets);
  return {
    scrollX: x - offsetX,
    scrollY: y - offsetY,
  };
}

/** A `DOMRect`-shaped rect (only the edges we need). */
export interface EdgeRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Derive the safe insets a single floating overlay occupies over its container, from bounding
 * rects. Assumes the overlay is docked flush to one edge and spans the full length of the
 * perpendicular axis (a right-docked panel, a bottom sheet, a left toolbar, ...); anything within
 * `edgeSlop` px of an edge counts as touching it.
 */
export function insetsFromOverlay(container: EdgeRect, overlay: EdgeRect, edgeSlop = 2): SafeInsets {
  const touchesTop = overlay.top <= container.top + edgeSlop;
  const touchesBottom = overlay.bottom >= container.bottom - edgeSlop;
  const touchesLeft = overlay.left <= container.left + edgeSlop;
  const touchesRight = overlay.right >= container.right - edgeSlop;

  if (touchesRight && touchesTop && touchesBottom) return { ...ZERO_INSETS, right: Math.max(0, container.right - overlay.left) };
  if (touchesLeft && touchesTop && touchesBottom) return { ...ZERO_INSETS, left: Math.max(0, overlay.right - container.left) };
  if (touchesBottom && touchesLeft && touchesRight) return { ...ZERO_INSETS, bottom: Math.max(0, container.bottom - overlay.top) };
  if (touchesTop && touchesLeft && touchesRight) return { ...ZERO_INSETS, top: Math.max(0, overlay.bottom - container.top) };
  return { ...ZERO_INSETS };
}
