import { describe, expect, it } from 'vitest';
import type { Project } from '@tagconn/shared';
import { MULTIVERSE_FLOOR_ID } from '@tagconn/shared';
import {
  firstFloor,
  floorNeighbors,
  floorsInOrder,
  isMultiverseFloor,
  isModalOpen,
  isTypingTarget,
  lastFloor,
  neighborFloor,
  topProjectFloor,
} from './floors';

function project(id: string, overrides: Partial<Project> = {}): Project {
  return { id, cwd: `/code/${id}`, name: id, archived: false, createdAt: 0, lastActivityAt: 0, ...overrides };
}

describe('floorsInOrder', () => {
  const projects = [
    project('c', { name: 'charlie', createdAt: 30, lastActivityAt: 10 }),
    project('a', { name: 'alpha', createdAt: 10, lastActivityAt: 30 }),
    project('b', { name: 'bravo', createdAt: 20, lastActivityAt: 20 }),
  ];

  it('orders by creation time by default (oldest = ground floor)', () => {
    expect(floorsInOrder(projects, 'created').map((p) => p.id)).toEqual(['a', 'b', 'c', MULTIVERSE_FLOOR_ID]);
  });

  it('orders by name', () => {
    expect(floorsInOrder(projects, 'name').map((p) => p.id)).toEqual(['a', 'b', 'c', MULTIVERSE_FLOOR_ID]);
  });

  it('orders by most recently active first', () => {
    expect(floorsInOrder(projects, 'recent').map((p) => p.id)).toEqual(['a', 'b', 'c', MULTIVERSE_FLOOR_ID]);
  });

  it('hides archived floors', () => {
    const withArchived = [...projects, project('d', { name: 'delta', archived: true, createdAt: 40 })];
    expect(floorsInOrder(withArchived, 'created').map((p) => p.id)).toEqual(['a', 'b', 'c', MULTIVERSE_FLOOR_ID]);
  });

  it('keeps the selected floor even if archived, so it is never stranded', () => {
    const withArchived = [...projects, project('d', { name: 'delta', archived: true, createdAt: 40 })];
    expect(floorsInOrder(withArchived, 'created', 'd').map((p) => p.id)).toEqual(['a', 'b', 'c', 'd', MULTIVERSE_FLOOR_ID]);
  });

  it('always appends the Multiverse last, above the top floor, regardless of order', () => {
    expect(floorsInOrder([], 'created').map((p) => p.id)).toEqual([MULTIVERSE_FLOOR_ID]);
    expect(isMultiverseFloor(floorsInOrder(projects, 'created').at(-1)!.id)).toBe(true);
  });
});

describe('Multiverse stairs (docs/design/living-office.md section 6.3)', () => {
  const projects = [project('a', { createdAt: 10 }), project('b', { createdAt: 20 }), project('c', { createdAt: 30 })];

  it('the top floor\'s up stairs lead to the Multiverse', () => {
    const order = floorsInOrder(projects, 'created');
    expect(neighborFloor(order, 'c', 'up')?.id).toBe(MULTIVERSE_FLOOR_ID);
  });

  it("the Multiverse's down stairs return to the top floor, and up is disabled", () => {
    const order = floorsInOrder(projects, 'created');
    expect(neighborFloor(order, MULTIVERSE_FLOOR_ID, 'down')?.id).toBe('c');
    expect(neighborFloor(order, MULTIVERSE_FLOOR_ID, 'up')).toBeUndefined();
  });

  it('topProjectFloor skips the Multiverse (End goes to the top project floor, not the Multiverse)', () => {
    const order = floorsInOrder(projects, 'created');
    expect(topProjectFloor(order)?.id).toBe('c');
    expect(lastFloor(order)?.id).toBe(MULTIVERSE_FLOOR_ID);
    expect(topProjectFloor([])).toBeUndefined();
  });
});

describe('floorNeighbors / neighborFloor', () => {
  const floors = [project('ground'), project('mid'), project('top')];

  it('reports index, count and both neighbors for a middle floor', () => {
    expect(floorNeighbors(floors, 'mid')).toEqual({ index: 1, count: 3, above: floors[2], below: floors[0] });
  });

  it('has no floor below the ground floor', () => {
    expect(floorNeighbors(floors, 'ground')).toEqual({ index: 0, count: 3, above: floors[1], below: undefined });
    expect(neighborFloor(floors, 'ground', 'down')).toBeUndefined();
  });

  it('has no floor above the top floor', () => {
    expect(floorNeighbors(floors, 'top')).toEqual({ index: 2, count: 3, above: undefined, below: floors[1] });
    expect(neighborFloor(floors, 'top', 'up')).toBeUndefined();
  });

  it('moves up and down between the ends', () => {
    expect(neighborFloor(floors, 'ground', 'up')).toBe(floors[1]);
    expect(neighborFloor(floors, 'top', 'down')).toBe(floors[1]);
  });

  it('returns null for a floor not in the list', () => {
    expect(floorNeighbors(floors, 'nowhere')).toBeNull();
  });

  it('firstFloor/lastFloor are the ends (or undefined when empty)', () => {
    expect(firstFloor(floors)).toBe(floors[0]);
    expect(lastFloor(floors)).toBe(floors[2]);
    expect(firstFloor([])).toBeUndefined();
    expect(lastFloor([])).toBeUndefined();
  });
});

describe('isTypingTarget', () => {
  it('ignores null', () => {
    expect(isTypingTarget(null)).toBe(false);
  });

  it('flags text-ish form controls', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      expect(isTypingTarget({ tagName: tag } as unknown as EventTarget)).toBe(true);
    }
  });

  it('flags contenteditable elements', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });

  it('does not flag a button or a plain div', () => {
    expect(isTypingTarget({ tagName: 'BUTTON', isContentEditable: false } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: false } as unknown as EventTarget)).toBe(false);
  });
});

describe('isModalOpen', () => {
  // The test environment has no DOM (`environment: 'node'`), so this takes an injectable `doc` —
  // the same reason the real caller can pass the real `document` without a dependency edge here.
  const fakeDoc = (found: boolean): Document => ({ querySelector: () => (found ? ({} as Element) : null) }) as unknown as Document;

  it('is false with no [aria-modal] or [data-modal] element on the page', () => {
    expect(isModalOpen(fakeDoc(false))).toBe(false);
  });

  it('is true while the Hall Planner (or any [data-modal]/[aria-modal="true"]) is open', () => {
    expect(isModalOpen(fakeDoc(true))).toBe(true);
  });
});
