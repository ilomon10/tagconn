import { describe, expect, it } from 'vitest';
import { rectFromBox, rectsOverlap } from '../geometry';
import { layoutLabels } from '../layout';
import type { LabelSubject } from '../types';

/** Deterministic PRNG (same one `game/procgen` uses) so a failure is always reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rand(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSubjects(n: number, rand: () => number, clustered: boolean): LabelSubject[] {
  // A handful of shared anchor points when `clustered`, so several subjects fight over the same
  // spot — the crowded-room case this whole module exists for.
  const anchors = Array.from({ length: clustered ? Math.max(1, Math.floor(n / 4)) : n }, () => ({
    x: Math.round(rand() * 400),
    y: Math.round(rand() * 300),
  }));
  return Array.from({ length: n }, (_, i) => ({
    id: `agent-${i}`,
    anchor: clustered ? anchors[i % anchors.length]! : anchors[i]!,
    box: { w: 20 + Math.round(rand() * 60), h: 10 + Math.round(rand() * 14) },
    selected: false,
    waiting: rand() < 0.15,
    recency: rand() * 1000,
  }));
}

function placedRects(subjects: LabelSubject[], badgeSize: { w: number; h: number }, maxBubbles: number) {
  const placements = layoutLabels(subjects, { maxBubbles, badgeSize });
  const byId = new Map(subjects.map((s) => [s.id, s]));
  return placements.map((p) => {
    const subject = byId.get(p.id)!;
    const box = p.collapsed ? badgeSize : subject.box;
    return rectFromBox({ x: subject.anchor.x + p.dx, y: subject.anchor.y + p.dy }, box);
  });
}

describe('layoutLabels: no overlaps', () => {
  it('never overlaps for N random boxes, scattered', () => {
    const rand = mulberry32(1);
    const subjects = randomSubjects(24, rand, false);
    const rects = placedRects(subjects, { w: 8, h: 8 }, 24); // uncapped: exercise the full slot search
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  it('never overlaps when many subjects share the same handful of anchors (a crowded room)', () => {
    const rand = mulberry32(7);
    const subjects = randomSubjects(20, rand, true);
    const rects = placedRects(subjects, { w: 8, h: 8 }, 20);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
      }
    }
  });

  it('holds across several seeds', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const rand = mulberry32(seed * 101);
      const subjects = randomSubjects(16, rand, seed % 2 === 0);
      const rects = placedRects(subjects, { w: 8, h: 8 }, 16);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          expect(rectsOverlap(rects[i]!, rects[j]!)).toBe(false);
        }
      }
    }
  });
});

describe('layoutLabels: priority ordering', () => {
  it('gives the selected subject the plain "above" slot even if others already claimed it', () => {
    const subjects: LabelSubject[] = [
      { id: 'crowd-1', anchor: { x: 100, y: 100 }, box: { w: 40, h: 12 }, selected: false, waiting: false, recency: 5 },
      { id: 'star', anchor: { x: 100, y: 100 }, box: { w: 40, h: 12 }, selected: true, waiting: false, recency: 0 },
    ];
    const placements = layoutLabels(subjects, { maxBubbles: 5 });
    const star = placements.find((p) => p.id === 'star')!;
    expect(star.slot).toBe('above');
    expect(star.leader).toBe(false);
  });
});

describe('layoutLabels: cap and collapse', () => {
  it('collapses everyone past maxBubbles, in priority order', () => {
    const subjects: LabelSubject[] = [
      { id: 'selected', anchor: { x: 0, y: 0 }, box: { w: 30, h: 10 }, selected: true, waiting: false, recency: 0 },
      { id: 'waiting', anchor: { x: 20, y: 0 }, box: { w: 30, h: 10 }, selected: false, waiting: true, recency: 0 },
      { id: 'recent', anchor: { x: 40, y: 0 }, box: { w: 30, h: 10 }, selected: false, waiting: false, recency: 10 },
      { id: 'older', anchor: { x: 60, y: 0 }, box: { w: 30, h: 10 }, selected: false, waiting: false, recency: 1 },
    ];
    const placements = layoutLabels(subjects, { maxBubbles: 2 });
    const collapsedById = Object.fromEntries(placements.map((p) => [p.id, p.collapsed]));
    expect(collapsedById['selected']).toBe(false);
    expect(collapsedById['waiting']).toBe(false);
    expect(collapsedById['recent']).toBe(true);
    expect(collapsedById['older']).toBe(true);
  });

  it('keeps every subject present in the output (collapsed, not dropped)', () => {
    const subjects: LabelSubject[] = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`,
      anchor: { x: i * 5, y: 0 },
      box: { w: 30, h: 10 },
      selected: false,
      waiting: false,
      recency: i,
    }));
    const placements = layoutLabels(subjects, { maxBubbles: 3 });
    expect(placements).toHaveLength(10);
    expect(placements.filter((p) => !p.collapsed)).toHaveLength(3);
  });
});

describe('layoutLabels: leader lines', () => {
  it('flags a leader whenever the box was displaced off the plain "above" slot', () => {
    const subjects: LabelSubject[] = [
      { id: 'a', anchor: { x: 0, y: 0 }, box: { w: 30, h: 10 }, selected: false, waiting: false, recency: 2 },
      { id: 'b', anchor: { x: 0, y: 0 }, box: { w: 30, h: 10 }, selected: false, waiting: false, recency: 1 },
    ];
    const placements = layoutLabels(subjects, { maxBubbles: 5 });
    const first = placements.find((p) => p.id === 'a')!;
    const second = placements.find((p) => p.id === 'b')!;
    expect(first.slot).toBe('above');
    expect(first.leader).toBe(false);
    expect(second.slot).not.toBe('above');
    expect(second.leader).toBe(true);
  });
});
