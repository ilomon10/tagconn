import type { LabelPlacement, LabelSubject, LayoutOptions, SlotKind } from './types';
import { rectFromBox, rectsOverlap, type Rect } from './geometry';
import { sortByPriority } from './priority';

interface Candidate {
  dx: number;
  dy: number;
  slot: SlotKind;
}

const DEFAULTS = { padding: 1, gap: 6, lateralGap: 4, stackGap: 3, maxStackLevels: 24, badgeSize: { w: 8, h: 8 } };

/** `above`, `above-left`, `above-right`, then increasingly higher `stacked` levels directly above
 *  the anchor (docs: "candidate slots ... with short leader lines when displaced"). Levels are
 *  spaced by this box's own height, so a subject can never stack back into its own earlier slot;
 *  `maxStackLevels` is generous so real crowding (see the "never overlaps" test) resolves well
 *  before it runs out — the last level is used regardless as a best-effort fallback. */
function candidatesFor(box: { w: number; h: number }, opts: Required<Omit<LayoutOptions, 'maxBubbles'>>): Candidate[] {
  const { gap, lateralGap, stackGap, maxStackLevels } = opts;
  const list: Candidate[] = [
    { dx: 0, dy: -gap, slot: 'above' },
    { dx: -(box.w / 2 + lateralGap), dy: -gap, slot: 'above-left' },
    { dx: box.w / 2 + lateralGap, dy: -gap, slot: 'above-right' },
  ];
  for (let level = 1; level <= maxStackLevels; level++) {
    list.push({ dx: 0, dy: -(gap + level * (box.h + stackGap)), slot: 'stacked' });
  }
  return list;
}

/**
 * Greedy collision-free bubble/tag placement (ROADMAP.md M8 8e). Subjects are visited in priority
 * order (`sortByPriority`); each takes the first candidate slot whose box doesn't overlap one
 * already placed. Past `maxBubbles`, a subject's box shrinks to `badgeSize` before it's placed (a
 * "…" dot badge instead of its real content), so a crowded room still fits everyone somewhere.
 * `leader` is true whenever the chosen slot isn't the plain `above` position, so the caller can
 * draw a short leader line back to the subject.
 */
export function layoutLabels(subjects: LabelSubject[], options: LayoutOptions): LabelPlacement[] {
  const opts = { ...DEFAULTS, ...options };
  const ordered = sortByPriority(subjects);
  const placed: Rect[] = [];
  const result: LabelPlacement[] = [];

  ordered.forEach((subject, index) => {
    const collapsed = index >= opts.maxBubbles;
    const box = collapsed ? opts.badgeSize : subject.box;
    const candidates = candidatesFor(box, opts);
    let chosen = candidates[candidates.length - 1]!;
    for (const c of candidates) {
      const rect = rectFromBox({ x: subject.anchor.x + c.dx, y: subject.anchor.y + c.dy }, box);
      if (!placed.some((p) => rectsOverlap(rect, p, opts.padding))) {
        chosen = c;
        break;
      }
    }
    placed.push(rectFromBox({ x: subject.anchor.x + chosen.dx, y: subject.anchor.y + chosen.dy }, box));
    result.push({ id: subject.id, dx: chosen.dx, dy: chosen.dy, slot: chosen.slot, leader: chosen.slot !== 'above', collapsed });
  });

  return result;
}
