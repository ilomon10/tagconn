import type { Facing } from '@tagconn/shared';
import type { FurnitureKind } from '../../game/procgen/types';
import { FACING_SUPPORT } from '../../game/procgen/facingSpec';

/**
 * Schematic glyphs and labels for the Hall Planner (docs/design/furnishing.md section 6.5). Pure data +
 * geometry: the canvas and the palette both read this, so a kind looks the same everywhere.
 */

/** One or two characters per kind, from fonts every platform ships (Geometric Shapes / Box Drawing / Misc Symbols). Exhaustive by type. */
const GLYPHS: Record<FurnitureKind, string> = {
  chair: '⌐',
  armchair: '◡',
  sofa: '⊏',
  bench: '═',
  booth: '⊐',
  counter: '▬',
  bookcase: '▤',
  shelf: '☰',
  'shelf-stack': '☷',
  cabinet: '▥',
  'filing-cabinet': '▦',
  board: '▭',
  'notice-board': '▣',
  'roster-board': '☷',
  lamp: '☀',
  plant: '♣',
  crate: '☒',
  bin: '▽',
  'coat-rack': '⑂',
  'supply-stack': '≡',
  rack: '▥',
  'rack-row': '▥▥',
  table: '▢',
  'reading-table': '▢',
  'standing-table': '○',
  'work-desk': '▭',
  'lead-desk': '▭',
  workbench: '▒',
  'lab-bench': '⚗',
  'reception-desk': '⌂',
  console: '⌨',
  equipment: '⚙',
  fridge: '❄',
  printer: '⎙',
  'water-cooler': '☁',
  'coffee-machine': '☕',
  fireplace: '♨',
  cage: '☷',
  arcade: '◧',
  'ping-pong': '◐',
  foosball: '⚓',
  'board-game-table': '⚆',
  centerpiece: '★',
  pedestal: '□',
  sigil: '✴',
  rug: '░',
  mat: '░',
  'wall-art': '◈',
  banner: '⚑',
  'stairs-up': '↑',
  'stairs-down': '↓',
};

/** Every kind the glyph map covers (test and palette enumerate it). */
export const GLYPH_KINDS = Object.keys(GLYPHS) as FurnitureKind[];

/** Glyph for a kind; a kind from stored data that is not a real one ("constructor", "__proto__") gets a neutral square. */
export function kindGlyph(kind: string): string {
  return Object.hasOwn(GLYPHS, kind) ? GLYPHS[kind as FurnitureKind] : '□';
}

/** Label for a furniture kind ("work-desk" -> "Work desk"). */
export function kindLabel(kind: string): string {
  const t = kind.replace(/-/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** True when the kind can face more than one way (R rotates it and the canvas draws a facing triangle). */
export function isRotatable(kind: string): boolean {
  return Object.hasOwn(FACING_SUPPORT, kind) && FACING_SUPPORT[kind as FurnitureKind].length > 1;
}

/**
 * The facing marker for a rect: a small triangle hugging the facing edge, pointing outward. Pixel space:
 * pass the rect in canvas px; returns the three vertices.
 */
export function facingTriangle(rect: { x: number; y: number; w: number; h: number }, facing: Facing): [number, number][] {
  const size = Math.max(3, Math.min(6, Math.min(rect.w, rect.h) * 0.3));
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  switch (facing) {
    case 'n':
      return [[cx - size, rect.y + size], [cx + size, rect.y + size], [cx, rect.y]];
    case 'e':
      return [[rect.x + rect.w - size, cy - size], [rect.x + rect.w - size, cy + size], [rect.x + rect.w, cy]];
    case 'w':
      return [[rect.x + size, cy - size], [rect.x + size, cy + size], [rect.x, cy]];
    default:
      return [[cx - size, rect.y + rect.h - size], [cx + size, rect.y + rect.h - size], [cx, rect.y + rect.h]];
  }
}
