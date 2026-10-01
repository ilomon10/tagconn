import { describe, expect, it } from 'vitest';
import { MENU_HOTKEYS } from '../app/menuHotkeys';
import { SEEN_STORAGE_KEY, TRIGGER_KINDS, TRIGGER_ORDER, TRIGGER_PANEL, TRIGGER_PLACE, createSeenStore, triggerLabel, triggerTooltip, triggersOf } from './furnitureTriggers';
import type { FurnitureAction, PlacedFurniture } from './procgen/types';

const ACTIONS = [...TRIGGER_ORDER];
const STYLES = ['modern', 'guild', 'rift'] as const;

function item(kind: PlacedFurniture['kind'], trigger?: FurnitureAction): PlacedFurniture {
  return { x: 0, y: 0, w: 1, h: 1, kind, blocking: true, roomId: 'r', roomType: 'desks', variant: 0, ...(trigger ? { trigger } : {}) };
}

describe('furnitureTriggers mapping', () => {
  it('covers every action in every table', () => {
    expect(new Set(TRIGGER_ORDER).size).toBe(6);
    for (const a of ACTIONS) {
      expect(TRIGGER_KINDS[a].length).toBeGreaterThan(0);
      expect(TRIGGER_PANEL[a]).toBeDefined();
    }
  });
  it('hotkeys equal MENU_HOTKEYS', () => {
    for (const a of ACTIONS) expect(TRIGGER_PANEL[a].hotkey).toBe(MENU_HOTKEYS[a]);
  });
  it('the placed kind qualifies for its action', () => {
    for (const [a, p] of Object.entries(TRIGGER_PLACE) as [keyof typeof TRIGGER_PLACE, (typeof TRIGGER_PLACE)[keyof typeof TRIGGER_PLACE]][]) {
      expect(TRIGGER_KINDS[a]).toContain(p.kind);
    }
  });
  it('has a distinct non-empty label per style and action', () => {
    for (const s of STYLES) for (const a of ACTIONS) expect(triggerLabel(s, a).length).toBeGreaterThan(0);
    expect(triggerLabel('guild', 'quests')).toBe('Quest board');
    expect(triggerLabel('rift', 'log')).toBe('Archive crystal');
  });
  it('formats the tooltip', () => {
    expect(triggerTooltip('guild', 'quests')).toBe('Quest board · Open Quests (Q)');
    expect(triggerTooltip('modern', 'receptionist')).toBe('Reception desk · Open Receptionist (D)');
  });
  it('triggersOf returns marked items in TRIGGER_ORDER', () => {
    const map = { furniture: [item('console', 'settings'), item('plant'), item('board', 'board'), item('reception-desk', 'receptionist'), item('roster-board', 'heroes')] };
    expect(triggersOf(map).map((f) => f.trigger)).toEqual(['receptionist', 'board', 'settings', 'heroes']);
    expect(triggersOf({ furniture: [] })).toEqual([]);
  });
});

describe('createSeenStore', () => {
  function fake(initial?: string) {
    const data = new Map<string, string>(initial === undefined ? [] : [[SEEN_STORAGE_KEY, initial]]);
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  }
  it('persists marks as a JSON array and reloads them', () => {
    const st = fake();
    const a = createSeenStore(st);
    expect(a.has('board')).toBe(false);
    a.mark('board');
    expect(a.has('board')).toBe(true);
    expect(JSON.parse(st.data.get(SEEN_STORAGE_KEY)!)).toEqual(['board']);
    expect(createSeenStore(st).has('board')).toBe(true);
  });
  it('does not accept inherited property names as actions', () => {
    const st = fake(JSON.stringify(['toString', 'constructor', '__proto__', 'board']));
    const s = createSeenStore(st);
    expect(s.has('toString' as never)).toBe(false);
    expect(s.has('board')).toBe(true);
  });
  it('ignores corrupt or hostile storage', () => {
    expect(createSeenStore(fake('not json')).has('board')).toBe(false);
    expect(createSeenStore(fake('{"a":1}')).has('board')).toBe(false);
    expect(createSeenStore(fake('["bogus","log"]')).has('log')).toBe(true);
  });
  it('works without storage and when storage throws', () => {
    const mem = createSeenStore(null);
    mem.mark('log');
    expect(mem.has('log')).toBe(true);
    const boom = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    const s = createSeenStore(boom);
    expect(() => s.mark('quests')).not.toThrow();
    expect(s.has('quests')).toBe(true);
  });
});
