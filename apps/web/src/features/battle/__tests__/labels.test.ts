import { CLASS_IDS, ITEM_IDS, LOOT_IDS, BATTLE_NPC_KINDS, MOVES, SKILL_TREES, type ClassId } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import { BATTLE_LABELS, battleLabel } from '../labels';

const STYLES = ['modern', 'guild', 'rift'] as const;
const TYPES = ['build', 'test', 'design', 'secure', 'review', 'insight', 'lead', 'grit', 'bug', 'bureaucrat', 'salesy', 'rival', 'feral', 'neutral'] as const;
const STATUSES = ['stunned', 'merge-conflict', 'burnout', 'buffed', 'shielded'] as const;

describe('battle labels', () => {
  for (const style of STYLES) {
    it(`${style}: every id is labelled and within length limits`, () => {
      const t = BATTLE_LABELS[style];
      for (const id of Object.keys(MOVES)) {
        expect(t.move[id], `move ${id}`).toBeTruthy();
        expect(t.move[id]!.length).toBeLessThanOrEqual(18);
      }
      for (const id of ITEM_IDS) expect(t.item[id], id).toBeTruthy();
      for (const id of CLASS_IDS) {
        expect(t.class[id], id).toBeTruthy();
        for (const b of [0, 1, 2]) expect(t.branch[`${id}.${b}` as `${ClassId}.0`], `${id}.${b}`).toBeTruthy();
      }
      for (const id of LOOT_IDS) {
        expect(t.loot[id], id).toBeTruthy();
        expect(t.loot[id].length).toBeLessThanOrEqual(24);
      }
      for (const id of BATTLE_NPC_KINDS) expect(t.enemy[id], id).toBeTruthy();
      for (const id of TYPES) expect(t.type[id], id).toBeTruthy();
      for (const id of STATUSES) expect(t.status[id], id).toBeTruthy();
    });
  }

  it('themes the spec examples', () => {
    expect(battleLabel('modern', 'move', 'hotfix')).toBe('Hotfix');
    expect(battleLabel('guild', 'move', 'hotfix')).toBe('Mending Rune');
    expect(battleLabel('rift', 'move', 'hotfix')).toBe('Patch Pulse');
    expect(battleLabel('guild', 'class', 'developer')).toBe('Artificer');
    expect(battleLabel('rift', 'class', 'developer')).toBe('Engineer');
    expect(battleLabel('rift', 'loot', 'title-bug-squasher')).toBe('Void Purger');
    expect(battleLabel('guild', 'type', 'bug')).toBe('Vermin');
    expect(battleLabel('rift', 'type', 'bug')).toBe('Glitch');
  });

  it('skill nodes: move nodes take the move name, passives read "+N% STAT"', () => {
    expect(battleLabel('guild', 'skill', 'developer.0.2')).toBe(battleLabel('guild', 'move', 'hotfix'));
    expect(battleLabel('modern', 'skill', 'developer.0.1')).toBe('+4% ATK');
    for (const c of CLASS_IDS) for (const n of SKILL_TREES[c].nodes) expect(battleLabel('modern', 'skill', n.id)).toBeTruthy();
  });

  it('unknown and prototype ids fall back to the humanized id', () => {
    expect(battleLabel('modern', 'move', 'brand-new-move')).toBe('Brand New Move');
    expect(battleLabel('rift', 'move', '__proto__')).toBe('Proto');
    expect(battleLabel('rift', 'class', 'constructor')).toBe('Constructor');
  });
});
