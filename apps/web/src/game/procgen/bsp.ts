import {
  DEFAULT_LAYOUT,
  hasLayoutErrors,
  LAYOUT_LIMITS,
  roomInterior,
  ROOM_MIN_INTERIOR,
  validateLayout,
  type LayoutBackground,
  type OfficeLayout,
  type OfficeLayoutInput,
  type RoomType,
} from '@tagconn/shared';
import { generateMap } from './generate';
import { mulberry32 } from './rng';
import type { Rect } from './types';

/** Room types assigned to BSP leaves, largest leaf first (guild-hall.md section 4, "Surprise me"). */
const FILL_ORDER: RoomType[] = [
  'desks',
  'meeting-room',
  'library',
  'lounge',
  'pm-office',
  'qa-lab',
  'review-booth',
  'server-room',
  'whiteboard',
];
const EXTRA_TYPES: RoomType[] = ['desks', 'lounge', 'hall'];

const MIN_LEAF = { w: 7, h: 6 };

/** Recursively split `rect`, stopping once a leaf is small enough (7x6..16x12-ish) or can't split further. */
function splitRect(rect: Rect, rand: () => number, depth: number, minArea: number): Rect[] {
  const canH = rect.w >= MIN_LEAF.w * 2 + 1;
  const canV = rect.h >= MIN_LEAF.h * 2 + 1;
  const withinLeafRange = rect.w <= 16 && rect.h <= 12;
  // The area floor keeps the leaf count (one room each) well under LAYOUT_LIMITS.maxRooms on big grids.
  if ((!canH && !canV) || depth > 10 || rect.w * rect.h <= minArea || (withinLeafRange && rand() < 0.4)) return [rect];

  const aspect = rect.w / rect.h;
  let horizontal: boolean;
  if (canH && canV) {
    if (aspect > 1.25) horizontal = true;
    else if (aspect < 0.8) horizontal = false;
    else horizontal = rand() < 0.5;
  } else {
    horizontal = canH;
  }

  if (horizontal) {
    const lo = MIN_LEAF.w;
    const hi = rect.w - MIN_LEAF.w;
    const cut = Math.max(lo, Math.min(hi, Math.round(rect.w * (0.35 + rand() * 0.3))));
    const left: Rect = { x: rect.x, y: rect.y, w: cut, h: rect.h };
    const right: Rect = { x: rect.x + cut, y: rect.y, w: rect.w - cut, h: rect.h };
    return [...splitRect(left, rand, depth + 1, minArea), ...splitRect(right, rand, depth + 1, minArea)];
  }
  const lo = MIN_LEAF.h;
  const hi = rect.h - MIN_LEAF.h;
  const cut = Math.max(lo, Math.min(hi, Math.round(rect.h * (0.35 + rand() * 0.3))));
  const top: Rect = { x: rect.x, y: rect.y, w: rect.w, h: cut };
  const bottom: Rect = { x: rect.x, y: rect.y + cut, w: rect.w, h: rect.h - cut };
  return [...splitRect(top, rand, depth + 1, minArea), ...splitRect(bottom, rand, depth + 1, minArea)];
}

/**
 * Shrink a leaf away from its neighbours (1 tile per side in `hall` mode, 1-3 in `void`), on every
 * side including ones that touch the outer grid boundary: an open (unwalled) room's footprint IS its
 * floor, so it must never touch the outer wall ring itself, only a walled room's own ring may. The
 * shrink amounts are scaled down (never negated into a grow) so the result always stays strictly
 * inside the original leaf - a room too small for its assigned type falls back to `hall` afterward.
 */
function shrinkLeaf(r: Rect, background: LayoutBackground, rand: () => number): Rect {
  const amount = () => (background === 'hall' ? 1 : 1 + Math.floor(rand() * 3));
  const safeMin = 3;
  let left = amount();
  let right = amount();
  if (left + right > r.w - safeMin) {
    const scale = Math.max(0, r.w - safeMin) / (left + right);
    left = Math.floor(left * scale);
    right = Math.floor(right * scale);
  }
  let top = amount();
  let bottom = amount();
  if (top + bottom > r.h - safeMin) {
    const scale = Math.max(0, r.h - safeMin) / (top + bottom);
    top = Math.floor(top * scale);
    bottom = Math.floor(bottom * scale);
  }
  return { x: r.x + left, y: r.y + top, w: r.w - left - right, h: r.h - top - bottom };
}

function area(r: Rect): number {
  return r.w * r.h;
}

/** Leave headroom under `maxRooms` so the fill-order list, entrance and stairs always fit. */
const LEAF_BUDGET = LAYOUT_LIMITS.maxRooms - 12;

/**
 * BSP leaves partition the exact WxH area, but skewed (very oblong) branches can bottom out at the
 * hard `MIN_LEAF` floor well before their area reaches `minArea`, so a single area estimate can still
 * overshoot the room budget. Escalate `minArea` (restarting the deterministic split from the same
 * seed) until the leaf count fits.
 */
function splitWithinBudget(width: number, height: number, seed: number): Rect[] {
  let minArea = Math.max(MIN_LEAF.w * MIN_LEAF.h, Math.ceil((width * height) / LEAF_BUDGET));
  for (let attempt = 0; attempt < 8; attempt++) {
    const rand = mulberry32(seed);
    const leaves = splitRect({ x: 0, y: 0, w: width, h: height }, rand, 0, minArea);
    if (leaves.length <= LEAF_BUDGET) return leaves;
    minArea = Math.ceil(minArea * 1.6);
  }
  return splitRect({ x: 0, y: 0, w: width, h: height }, mulberry32(seed), 0, width * height);
}

/** Build one BSP candidate layout for a given seed. May still fail `validateLayout`/`generateMap`; the caller retries with another seed. */
function buildCandidate(opts: { width: number; height: number; seed: number; background: LayoutBackground; name: string }): OfficeLayoutInput {
  const { width, height, seed, background, name } = opts;
  const rand = mulberry32(seed);
  const rawLeaves = splitWithinBudget(width, height, seed);
  const leaves = rawLeaves.map((leaf) => shrinkLeaf(leaf, background, rand));

  // Entrance: the leaf touching the bottom edge, closest to the horizontal centre.
  const bottomLeaves = rawLeaves
    .map((raw, i) => ({ raw, leaf: leaves[i]!, i }))
    .filter(({ raw }) => raw.y + raw.h === height);
  const centreX = width / 2;
  bottomLeaves.sort((a, b) => Math.abs(a.leaf.x + a.leaf.w / 2 - centreX) - Math.abs(b.leaf.x + b.leaf.w / 2 - centreX));
  const entranceIdx = bottomLeaves[0]?.i ?? 0;

  // Stairs: the smallest remaining leaf (a simplification of "carved at a corner of the entrance's
  // neighbouring hall leaf, or the smallest leaf" - always safe since any leaf fits a 2x2 stairs interior).
  const remainingIdx = leaves.map((_, i) => i).filter((i) => i !== entranceIdx);
  remainingIdx.sort((a, b) => area(leaves[a]!) - area(leaves[b]!));
  const stairsIdx = remainingIdx[0];

  const types = new Map<number, RoomType>();
  types.set(entranceIdx, 'entrance');
  if (stairsIdx !== undefined) types.set(stairsIdx, 'stairs');

  const fillIdx = remainingIdx.filter((i) => i !== stairsIdx);
  fillIdx.sort((a, b) => area(leaves[b]!) - area(leaves[a]!)); // largest first
  fillIdx.forEach((i, order) => {
    const type = order < FILL_ORDER.length ? FILL_ORDER[order]! : EXTRA_TYPES[Math.floor(rand() * EXTRA_TYPES.length)]!;
    types.set(i, type);
  });

  const rooms: OfficeLayoutInput['rooms'] = leaves.map((leaf, i) => {
    let type = types.get(i) ?? 'hall';
    // A leaf too small for its assigned type's minimum interior falls back to `hall` (always valid: min 2x2, open).
    const interior = roomInterior({ ...leaf, type, walled: undefined });
    const min = ROOM_MIN_INTERIOR[type];
    if (interior.w < min.w || interior.h < min.h) type = 'hall';
    return { id: `r${i + 1}`, type, x: leaf.x, y: leaf.y, w: leaf.w, h: leaf.h };
  });

  return {
    name,
    width,
    height,
    seed,
    background,
    corridorWidth: 2,
    rooms,
  };
}

/**
 * "Surprise me" BSP layout generator (guild-hall.md section 4). Deterministic per seed. Retries with
 * `seed + k` (k up to 20) if the candidate fails validation or generation; falls back to
 * `DEFAULT_LAYOUT` (resized when the requested size matches, otherwise returned unchanged) if every
 * retry fails.
 */
export function generateRandomLayout(opts: {
  width: number;
  height: number;
  seed: number;
  background?: LayoutBackground;
  name?: string;
}): OfficeLayoutInput {
  const background = opts.background ?? 'hall';
  const name = opts.name ?? 'Surprise Floor';

  for (let k = 0; k <= 20; k++) {
    const candidate = buildCandidate({ width: opts.width, height: opts.height, seed: (opts.seed + k) >>> 0, background, name });
    const geomIssues = validateLayout(candidate);
    if (hasLayoutErrors(geomIssues)) continue;
    const asLayout: OfficeLayout = {
      ...candidate,
      background: candidate.background ?? 'hall',
      corridorWidth: candidate.corridorWidth ?? 2,
      id: 'preview',
      builtin: false,
      createdAt: 0,
      updatedAt: 0,
    };
    const map = generateMap(asLayout);
    if (!hasLayoutErrors(map.issues)) return candidate;
  }

  // DEFAULT_LAYOUT is only guaranteed valid in its own `hall` background (its rooms share walls with
  // no void gap between them), so the fallback keeps it as-is rather than forcing the requested background.
  if (opts.width === DEFAULT_LAYOUT.width && opts.height === DEFAULT_LAYOUT.height) {
    return { ...DEFAULT_LAYOUT, name, seed: opts.seed };
  }
  return { ...DEFAULT_LAYOUT, name };
}
