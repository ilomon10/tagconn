import { NPC_KINDS } from '@tagconn/shared';
import { describe, expect, it } from 'vitest';
import type { FurnitureKind } from '../../procgen/types';
import { SFX_IDS } from '../../sfxBus';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import { riftTheme } from '../rift';
import type { CreatureId, MeetingLines, ThemeDefinition } from '../types';

const MAX_LINE = 48;
const FURNITURE_KINDS: ReadonlySet<string> = new Set<FurnitureKind>([
  'work-desk', 'lead-desk', 'table', 'board', 'workbench', 'booth', 'rack', 'shelf', 'sofa', 'armchair', 'rug', 'mat', 'counter',
  'plant', 'centerpiece', 'pedestal', 'sigil', 'stairs-up', 'stairs-down', 'rack-row', 'console', 'lab-bench', 'equipment',
  'shelf-stack', 'reading-table', 'standing-table', 'reception-desk', 'bench', 'lamp', 'crate', 'wall-art', 'bin', 'cabinet',
  'chair', 'banner', 'printer', 'fridge', 'water-cooler', 'filing-cabinet', 'coffee-machine', 'bookcase', 'fireplace',
  'coat-rack', 'supply-stack', 'cage', 'notice-board', 'roster-board', 'arcade', 'ping-pong', 'foosball', 'board-game-table',
]);
const CREATURES: ReadonlySet<string> = new Set<CreatureId>(['dog', 'cat', 'monster', 'wolf', 'familiar', 'slime', 'hover-hound', 'astro-cat', 'void-blob']);
const POOLS = ['invite', 'fetch', 'dawdle', 'talk', 'close'] as const satisfies readonly (keyof MeetingLines)[];

const themes: ThemeDefinition[] = [modernTheme, guildTheme, riftTheme];

function checkLine(where: string, line: string): void {
  expect(line.trim().length, `${where} is empty`).toBeGreaterThan(0);
  expect(line.length, `${where} (${line.length} chars): ${line}`).toBeLessThanOrEqual(MAX_LINE);
}

describe('theme life content', () => {
  it('rift sets both life and npcs', () => {
    expect(riftTheme.life).toBeDefined();
    expect(riftTheme.npcs).toBeDefined();
  });

  for (const theme of themes) {
    const life = theme.life;
    describe.skipIf(!life)(`${theme.id} life`, () => {
      it('has >= 11 unique, valid activities', () => {
        const acts = life?.activities ?? [];
        expect(acts.length).toBeGreaterThanOrEqual(11);
        expect(new Set(acts.map((a) => a.id)).size).toBe(acts.length);
        for (const a of acts) {
          expect(a.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
          for (const k of a.requires) expect(FURNITURE_KINDS.has(k), `${a.id} requires unknown kind ${k}`).toBe(true);
          expect(a.cast[0], a.id).toBeLessThanOrEqual(a.cast[1]);
          expect(a.weight, a.id).toBeGreaterThan(0);
          expect(a.durationSec[0], a.id).toBeGreaterThan(0);
          expect(a.durationSec[0], a.id).toBeLessThanOrEqual(a.durationSec[1]);
          expect(a.lines.length, `${a.id} needs lines`).toBeGreaterThan(0);
          a.lines.forEach((l, i) => checkLine(`${theme.id}/${a.id} line ${i}`, l));
        }
      });

      it('covers both solo and group activities, some in place', () => {
        const acts = life?.activities ?? [];
        expect(acts.some((a) => a.cast[1] === 1)).toBe(true);
        expect(acts.some((a) => a.cast[1] >= 2)).toBe(true);
        expect(acts.some((a) => a.requires.length === 0)).toBe(true);
      });

      it('has >= 3 short lines in every meeting pool', () => {
        for (const kind of ['kickoff', 'standup'] as const) {
          for (const pool of POOLS) {
            const lines = life?.[kind][pool] ?? [];
            expect(lines.length, `${theme.id}.${kind}.${pool}`).toBeGreaterThanOrEqual(3);
            lines.forEach((l, i) => checkLine(`${theme.id}.${kind}.${pool}[${i}]`, l));
          }
        }
      });
    });

    const npcs = theme.npcs;
    describe.skipIf(!npcs)(`${theme.id} npcs`, () => {
      it('has a valid skin for every NpcKind', () => {
        for (const kind of NPC_KINDS) {
          const skin = npcs?.skins[kind];
          expect(skin, `${theme.id} skin ${kind}`).toBeDefined();
          if (!skin) continue;
          expect(skin.name.length).toBeGreaterThan(0);
          expect(skin.jingle).toBeGreaterThanOrEqual(0);
          expect(skin.jingle).toBeLessThanOrEqual(3);
          if (skin.creature) expect(CREATURES.has(skin.creature), `${kind} creature ${skin.creature}`).toBe(true);
          if (skin.sound) expect(SFX_IDS).toContain(skin.sound);
          expect(skin.lines.length, `${kind} needs lines`).toBeGreaterThan(0);
          skin.lines.forEach((l, i) => checkLine(`${theme.id}.${kind} line ${i}`, l));
        }
      });
    });
  }
});
