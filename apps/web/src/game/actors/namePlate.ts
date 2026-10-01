// Pure plate layout in plate pixels (docs/design/office-life.md 3.1.3); no Phaser here.
import type { LabelTaskMode, Settings } from '@tagconn/shared';

export type PlateStyle = 'name' | 'title' | 'task';
export interface PlateMetrics { advance: Record<PlateStyle, number>; lineH: Record<PlateStyle, number>; pad: number; gap: number }
export const PIXEL_METRICS: PlateMetrics = {
  advance: { name: 6, title: 4, task: 4 },
  lineH: { name: 8, title: 6, task: 6 },
  pad: 2,
  gap: 1,
};
export type MeasureFn = (text: string, style: PlateStyle) => number;
export interface PlateLine { text: string; style: PlateStyle; w: number }
export interface PlateLayout { lines: PlateLine[]; w: number; h: number } // w/h include padding, in pp

export function pixelMeasure(metrics: PlateMetrics = PIXEL_METRICS): MeasureFn {
  return (text, style) => text.length * metrics.advance[style];
}

const ELLIPSIS = '…';

/** Cuts `text` so that it plus a trailing ellipsis fits `maxW`. Empty when not even the ellipsis fits. */
function cutWithEllipsis(text: string, maxW: number, measure: (t: string) => number): string {
  let cut = text;
  while (cut.length > 0 && measure(cut.trimEnd() + ELLIPSIS) > maxW) cut = cut.slice(0, -1);
  if (measure(cut.trimEnd() + ELLIPSIS) > maxW) return '';
  return cut.trimEnd() + ELLIPSIS;
}

/** Line 1 name (ellipsized to maxW), line 2 title (optional, ellipsized), then the task word-wrapped to
 *  `maxLines` lines (last one ellipsized; one over-long word is hard-cut). Empty title/task or maxLines 0 = omitted. */
export function layoutPlate(
  name: string, title: string | undefined, task: string | undefined, maxW: number, maxLines: number,
  measure: MeasureFn = pixelMeasure(), metrics: PlateMetrics = PIXEL_METRICS,
): PlateLayout {
  const lines: PlateLine[] = [];
  const push = (text: string, style: PlateStyle) => {
    if (text) lines.push({ text, style, w: measure(text, style) });
  };
  push(ellipsize(name.trim(), maxW, (t) => measure(t, 'name')), 'name');
  const t = title?.trim();
  if (t) push(ellipsize(t, maxW, (s) => measure(s, 'title')), 'title');
  const k = task?.trim();
  if (k && maxLines > 0) {
    for (const l of wrapWords(k, maxW, maxLines, (s) => measure(s, 'task'))) push(l, 'task');
  }
  let w = 0;
  let h = 0;
  for (const l of lines) {
    w = Math.max(w, l.w);
    h += metrics.lineH[l.style];
  }
  if (lines.length > 1) h += (lines.length - 1) * metrics.gap;
  return { lines, w: w + metrics.pad * 2, h: h + metrics.pad * 2 };
}

/** Greedy word wrap to `maxLines` lines no wider than `maxW`. Over-long words are hard-cut; when the text does not
 *  fit, the last line ends with an ellipsis. */
export function wrapWords(text: string, maxW: number, maxLines: number, measure: (t: string) => number): string[] {
  if (maxLines <= 0) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (let word of words) {
    while (measure(word) > maxW) {
      // Hard-cut a word wider than a whole line.
      if (cur) { lines.push(cur); cur = ''; }
      let n = word.length;
      while (n > 1 && measure(word.slice(0, n)) > maxW) n--;
      lines.push(word.slice(0, n));
      word = word.slice(n);
      if (lines.length > maxLines) break;
    }
    if (!word) continue;
    if (!cur) cur = word;
    else if (measure(cur + ' ' + word) <= maxW) cur += ' ' + word;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = cutWithEllipsis(kept[maxLines - 1]!, maxW, measure);
  return kept.filter(Boolean);
}

export function ellipsize(text: string, maxW: number, measure: (t: string) => number): string {
  if (measure(text) <= maxW) return text;
  return cutWithEllipsis(text, maxW, measure);
}

/** World scale per plate pixel: every font pixel is a whole number (>= 1) of screen pixels at this zoom. */
export function plateGlyphScale(zoom: number): number {
  return Math.max(1, Math.round(zoom * 0.5)) / zoom;
}

export interface PlateOptions { showTask: LabelTaskMode; taskLines: number; maxWidthChars: number; showTitle: boolean; pixelFont: boolean }
export function plateOptions(labels: Settings['office']['labels']): PlateOptions {
  return {
    showTask: labels.showTask,
    taskLines: labels.taskLines,
    maxWidthChars: labels.maxWidthChars,
    showTitle: labels.showTitle,
    pixelFont: labels.pixelFont,
  };
}

/** showTask 'always' | ('focus' and (selected or hovered)). */
export function taskVisible(mode: LabelTaskMode, selected: boolean, hovered: boolean): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return selected || hovered;
}
