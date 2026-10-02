import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { FurnitureKind, PlacedFurniture } from '../../procgen/types';
import { guildTheme } from '../guild';
import { modernTheme } from '../modern';
import { riftTheme } from '../rift';
import { integerFootprints, makeCommandGraphics } from './testUtils';
import { ALL_FURNITURE_KINDS } from './painterKinds';

// M16 F3: at integer sizes (facing s) every painter must emit the exact command stream it did before the painter audit.
// One digest per theme x kind over every size x variant x againstNorthWall x room variant. Regenerate (only for an
// intentional art change): WRITE_PAINTER_SNAPSHOT=1 pnpm --filter @tagconn/web exec vitest run painterRects
const SNAP = fileURLToPath(new URL('./painterRects.snap.json', import.meta.url));
const THEMES = { modern: modernTheme, guild: guildTheme, rift: riftTheme } as const;
const ROOMS = ['desks', 'lounge', 'library', 'meeting-room', 'pm-office', 'whiteboard', 'qa-lab', 'entrance'] as const;

function digest(theme: (typeof THEMES)[keyof typeof THEMES], kind: FurnitureKind): string {
  const h = createHash('sha1');
  for (const { w, h: fh } of integerFootprints)
    for (const variant of [0, 1, 2, 3])
      for (const against of [false, true])
        for (const roomType of ROOMS) {
          const f: PlacedFurniture = { x: 2, y: 5, w, h: fh, kind, blocking: true, roomId: 'r1', roomType, variant, againstNorthWall: against };
          const { g, commands } = makeCommandGraphics();
          theme.paintFurniture(g, f, 16);
          h.update(JSON.stringify(commands));
        }
  return h.digest('hex');
}

describe('integer-size painter output is byte-identical (M16 F3)', () => {
  const current: Record<string, string> = {};
  for (const [name, theme] of Object.entries(THEMES)) for (const kind of ALL_FURNITURE_KINDS) current[`${name}/${kind}`] = digest(theme, kind);

  if (process.env.WRITE_PAINTER_SNAPSHOT) writeFileSync(SNAP, JSON.stringify(current, null, 1) + '\n');
  const expected: Record<string, string> = existsSync(SNAP) ? JSON.parse(readFileSync(SNAP, 'utf8')) : {};

  it.each(Object.keys(current))('%s', (key) => {
    expect(current[key]).toBe(expected[key]);
  });
});
