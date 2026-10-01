// STUB (W0b): W1-1 owns the real layout (docs/design/office-life.md 3.1.3). Signatures are final.
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

/** Line 1 name (ellipsized to maxW), line 2 title (optional, ellipsized), then the task word-wrapped to
 *  `maxLines` lines (last one ellipsized; one over-long word is hard-cut). Empty title/task or maxLines 0 = omitted. */
export function layoutPlate(
  name: string, _title: string | undefined, _task: string | undefined, _maxW: number, _maxLines: number,
  measure: MeasureFn = pixelMeasure(), metrics: PlateMetrics = PIXEL_METRICS,
): PlateLayout {
  const w = measure(name, 'name');
  return {
    lines: [{ text: name, style: 'name', w }],
    w: w + metrics.pad * 2,
    h: metrics.lineH.name + metrics.pad * 2,
  };
}

export function wrapWords(text: string, _maxW: number, _maxLines: number, _measure: (t: string) => number): string[] {
  return text ? [text] : [];
}

export function ellipsize(text: string, _maxW: number, _measure: (t: string) => number): string {
  return text;
}

export function plateGlyphScale(_zoom: number): number {
  return 1;
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
export function taskVisible(_mode: LabelTaskMode, _selected: boolean, _hovered: boolean): boolean {
  return false;
}
