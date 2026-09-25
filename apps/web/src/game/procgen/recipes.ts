import type { RoomType } from '@tagconn/shared';
import type { FurnitureKind, Rect } from './types';

export interface RecipeItem {
  kind: FurnitureKind;
  x: number;
  y: number;
  w: number;
  h: number;
  blocking: boolean;
  variant: number;
}
export interface RecipeSeat {
  x: number;
  y: number;
  kind: 'sit' | 'stand';
}

/**
 * Furniture + seat recipes per room type, generalised from the pre-M7 `officeMap.furnish()` to work
 * on any interior rect at least `ROOM_MIN_INTERIOR` (guild-hall.md section 4, step 8, and the guild
 * mapping table in section 3 for which `FurnitureKind`s each room type uses). `rand` is the room's
 * own seeded stream, so editing one room never reshuffles another's variants.
 */
export function furnishRoom(type: RoomType, r: Rect, rand: () => number): { furniture: RecipeItem[]; seats: RecipeSeat[] } {
  const furniture: RecipeItem[] = [];
  const seats: RecipeSeat[] = [];
  const x2 = r.x + r.w - 1;
  const y2 = r.y + r.h - 1;
  const block = (kind: FurnitureKind, x: number, y: number, w = 1, h = 1) =>
    furniture.push({ kind, x, y, w, h, blocking: true, variant: Math.floor(rand() * 4) });
  const soft = (kind: FurnitureKind, x: number, y: number, w = 1, h = 1) =>
    furniture.push({ kind, x, y, w, h, blocking: false, variant: Math.floor(rand() * 4) });
  const sit = (x: number, y: number) => seats.push({ x, y, kind: 'sit' });
  const stand = (x: number, y: number) => seats.push({ x, y, kind: 'stand' });

  switch (type) {
    case 'desks': {
      for (let y = r.y + 1; y + 1 <= y2; y += 3) {
        for (let x = r.x + 1; x + 1 <= x2 - 1; x += 4) {
          block('work-desk', x, y, 2, 1);
          sit(x, y + 1);
          sit(x + 1, y + 1);
        }
      }
      break;
    }
    case 'meeting-room': {
      const tx = r.x + 2;
      const ty = r.y + 2;
      const tw = Math.max(1, r.w - 4);
      const th = Math.max(1, r.h - 4);
      block('table', tx, ty, tw, th);
      for (let x = tx; x < tx + tw; x++) {
        sit(x, ty - 1);
        sit(x, ty + th);
      }
      for (let y = ty; y < ty + th; y++) {
        sit(tx - 1, y);
        sit(tx + tw, y);
      }
      block('plant', r.x, r.y);
      break;
    }
    case 'whiteboard': {
      block('board', r.x + 1, r.y, Math.max(1, r.w - 2), 1);
      if (r.w >= 5 && r.h >= 5) soft('centerpiece', r.x + Math.floor(r.w / 2), r.y + Math.floor(r.h / 2));
      for (let y = r.y + 2; y <= y2; y += 2) for (let x = r.x + 1; x <= x2 - 1; x += 2) stand(x, y);
      break;
    }
    case 'pm-office': {
      block('lead-desk', r.x + 2, r.y + 2, 3, 1);
      sit(r.x + 3, r.y + 1);
      soft('rug', r.x + 2, r.y + 4, 4, 2);
      stand(r.x + 2, r.y + 4);
      stand(r.x + 4, r.y + 4);
      stand(r.x + 3, r.y + 5);
      block('plant', x2, r.y);
      block('shelf', x2 - 2, r.y, 2, 1);
      break;
    }
    case 'library': {
      block('shelf', r.x, r.y, r.w, 1);
      const mid = r.y + 3;
      if (mid < y2) {
        const gap = r.x + Math.floor(r.w / 2);
        block('shelf', r.x + 1, mid, Math.max(1, gap - r.x - 1), 1);
        block('shelf', gap + 2, mid, Math.max(1, x2 - gap - 2), 1);
      }
      for (let x = r.x + 1; x <= x2; x += 2) stand(x, r.y + 1);
      for (let x = r.x + 1; x <= x2; x += 3) stand(x, mid + 1);
      soft('armchair', r.x + 1, y2);
      soft('armchair', x2 - 1, y2);
      sit(r.x + 1, y2);
      sit(x2 - 1, y2);
      break;
    }
    case 'qa-lab': {
      for (let y = r.y + 1; y + 1 <= y2; y += 3) {
        block('workbench', r.x + 1, y, Math.max(1, r.w - 2), 1);
        for (let x = r.x + 1; x <= x2 - 1; x += 2) stand(x, y + 1);
      }
      if (r.w >= 5 && r.h >= 5) block('centerpiece', r.x + Math.floor(r.w / 2), y2 - 1, 2, 2);
      break;
    }
    case 'review-booth': {
      for (let y = r.y + 1; y + 1 <= y2; y += 3) {
        block('booth', r.x + 1, y);
        sit(r.x + 1, y + 1);
        if (r.w >= 5) {
          block('booth', x2 - 1, y);
          sit(x2 - 1, y + 1);
        }
      }
      break;
    }
    case 'server-room': {
      for (let x = r.x + 1; x <= x2 - 1; x += 3) {
        block('rack', x, r.y + 1, 1, Math.max(1, r.h - 3));
        for (let y = r.y + 1; y <= y2 - 2; y += 2) stand(x + 1, y);
      }
      if (r.w >= 5 && r.h >= 5) soft('sigil', r.x + Math.floor(r.w / 2) - 1, y2 - 3, 3, 3);
      block('pedestal', x2, y2);
      break;
    }
    case 'lounge': {
      soft('sofa', r.x + 1, r.y + 1, 4, 1);
      for (let x = r.x + 1; x < r.x + 5; x++) sit(x, r.y + 1);
      block('table', r.x + 2, r.y + 3, 2, 1);
      soft('armchair', r.x + 5, r.y + 3);
      sit(r.x + 5, r.y + 3);
      block('counter', x2 - 1, r.y);
      stand(x2 - 1, r.y + 1);
      stand(x2 - 2, r.y + 2);
      block('plant', x2, y2);
      block('plant', r.x, y2);
      soft('rug', r.x + 1, r.y + 2, 5, 3);
      for (let x = r.x + 2; x <= x2 - 2; x += 2) stand(x, y2 - 1);
      break;
    }
    case 'entrance': {
      const cx = r.x + Math.floor(r.w / 2);
      soft('mat', cx - 1, y2, 2, 1);
      block('plant', r.x, r.y);
      block('plant', x2, r.y);
      for (let y = r.y + 1; y <= y2 - 1; y += 2) for (let x = r.x + 1; x <= x2 - 1; x += 2) stand(x, y);
      break;
    }
    // 'stairs' and 'hall' have no furniture recipe: stairs get stairs-up/down in generate.ts, and
    // hall is corridor/open floor with decor slots only.
    default:
      break;
  }
  return { furniture, seats };
}
