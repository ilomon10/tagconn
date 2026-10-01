import { describe, expect, it } from 'vitest';
import { SettingsSchema } from '@tagconn/shared';
import {
  ellipsize, layoutPlate, PIXEL_METRICS, pixelMeasure, plateGlyphScale, plateOptions, taskVisible, wrapWords,
} from '../namePlate';

const m = pixelMeasure();
const small = (t: string) => m(t, 'task');
const MAXW = 144;

describe('layoutPlate', () => {
  it('name only is one line', () => {
    const l = layoutPlate('Ada', undefined, undefined, MAXW, 2);
    expect(l.lines.map((x) => x.style)).toEqual(['name']);
    expect(l.w).toBe(3 * 6 + 4);
    expect(l.h).toBe(PIXEL_METRICS.lineH.name + 4);
  });

  it('name + title is two lines with gap in h', () => {
    const l = layoutPlate('Ada', 'Lead dev', undefined, MAXW, 2);
    expect(l.lines.map((x) => x.style)).toEqual(['name', 'title']);
    expect(l.h).toBe(PIXEL_METRICS.lineH.name + PIXEL_METRICS.gap + 6 + 4);
    expect(l.w).toBe(Math.max(18, 8 * 4) + 4);
  });

  it('task wraps to exactly maxLines with an ellipsis on the last', () => {
    const task = 'refactor the authentication module and then write a lot of tests for every edge case you can find';
    const l = layoutPlate('Ada', 'Dev', task, MAXW, 2);
    const t = l.lines.filter((x) => x.style === 'task');
    expect(t).toHaveLength(2);
    expect(t[1]!.text.endsWith('…')).toBe(true);
    for (const x of l.lines) expect(x.w).toBeLessThanOrEqual(MAXW);
  });

  it('hard-cuts a word longer than maxW', () => {
    const l = layoutPlate('A', undefined, 'x'.repeat(100), MAXW, 3);
    const t = l.lines.filter((x) => x.style === 'task');
    expect(t).toHaveLength(3);
    for (const x of t) expect(x.w).toBeLessThanOrEqual(MAXW);
  });

  it('omits an empty/whitespace task, empty title, and maxLines 0', () => {
    expect(layoutPlate('A', '  ', '   ', MAXW, 2).lines).toHaveLength(1);
    expect(layoutPlate('A', undefined, 'do things', MAXW, 0).lines).toHaveLength(1);
  });

  it('ellipsizes a long name within maxW', () => {
    const l = layoutPlate('N'.repeat(40), undefined, undefined, MAXW, 0);
    expect(l.lines[0]!.w).toBeLessThanOrEqual(MAXW);
    expect(l.lines[0]!.text.endsWith('…')).toBe(true);
    expect(l.w).toBeLessThanOrEqual(MAXW + 4);
  });
});

describe('bounded measure work', () => {
  it('a 100k-char description lays out with few measure calls', () => {
    let calls = 0;
    const counting = (t: string, s: Parameters<typeof m>[1]) => { calls++; return m(t, s); };
    for (const big of ['x'.repeat(100_000), 'ab '.repeat(40_000)]) {
      calls = 0;
      const l = layoutPlate('A', 'B', big, MAXW, 3, counting);
      expect(calls).toBeLessThan(500);
      for (const x of l.lines) expect(x.w).toBeLessThanOrEqual(MAXW);
    }
  });
  it('ellipsize of a long string is logarithmic', () => {
    let calls = 0;
    const out = ellipsize('y'.repeat(100_000), 40, (t) => { calls++; return small(t); });
    expect(out).toBe('yyyyyyyyy…');
    expect(calls).toBeLessThan(40);
  });
});

describe('wrapWords / ellipsize', () => {
  it('wraps greedily and keeps short text intact', () => {
    expect(wrapWords('a b c', MAXW, 2, small)).toEqual(['a b c']);
    expect(wrapWords('aaaa bbbb', 32, 3, small)).toEqual(['aaaa', 'bbbb']);
    expect(wrapWords('', MAXW, 2, small)).toEqual([]);
  });
  it('ellipsize leaves fitting text alone', () => {
    expect(ellipsize('abc', 100, small)).toBe('abc');
    expect(ellipsize('abcdefghij', 20, small)).toBe('abcd…');
  });
});

describe('plateGlyphScale', () => {
  it('gives integer screen pixels >= 1 for zoom 0.25..4', () => {
    for (let z = 0.25; z <= 4; z += 0.05) {
      const px = z * plateGlyphScale(z);
      expect(px).toBeGreaterThanOrEqual(1 - 1e-9);
      expect(Math.abs(px - Math.round(px))).toBeLessThan(1e-9);
    }
  });
});

describe('taskVisible', () => {
  it('truth table', () => {
    for (const s of [false, true]) for (const h of [false, true]) {
      expect(taskVisible('always', s, h)).toBe(true);
      expect(taskVisible('never', s, h)).toBe(false);
      expect(taskVisible('focus', s, h)).toBe(s || h);
    }
  });
});

describe('plateOptions', () => {
  it('maps the label settings', () => {
    const labels = SettingsSchema.parse({}).office.labels;
    expect(plateOptions(labels)).toEqual({
      showTask: labels.showTask, taskLines: labels.taskLines, maxWidthChars: labels.maxWidthChars,
      showTitle: labels.showTitle, pixelFont: labels.pixelFont,
    });
  });
});
