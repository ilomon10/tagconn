import { describe, expect, it } from 'vitest';
import type { LayoutIssue } from '@tagconn/shared';
import { canSaveLayout, sealedRoomWarnings } from './saveGate';

const issue = (over: Partial<LayoutIssue> = {}): LayoutIssue => ({ severity: 'warning', code: 'room-sealed', message: 'x', ...over });

describe('canSaveLayout (save-blocking logic)', () => {
  it('allows saving with no issues', () => {
    expect(canSaveLayout([], false)).toBe(true);
  });

  it('blocks saving on any error, including a genuinely unreachable room', () => {
    expect(canSaveLayout([issue({ severity: 'error', code: 'unreachable-room' })], false)).toBe(false);
    expect(canSaveLayout([issue({ severity: 'error', code: 'overlap' })], false)).toBe(false);
  });

  it('does NOT block saving on a room-sealed warning alone (the caller confirms separately)', () => {
    expect(canSaveLayout([issue({ severity: 'warning', code: 'room-sealed' })], false)).toBe(true);
  });

  it('blocks saving while editing a read-only builtin, regardless of issues', () => {
    expect(canSaveLayout([], true)).toBe(false);
  });
});

describe('sealedRoomWarnings', () => {
  it('returns only the room-sealed warnings', () => {
    const issues = [
      issue({ code: 'room-sealed', roomIds: ['a'] }),
      issue({ severity: 'error', code: 'unreachable-room', roomIds: ['b'] }),
      issue({ code: 'zone-missing' }),
    ];
    expect(sealedRoomWarnings(issues)).toEqual([issue({ code: 'room-sealed', roomIds: ['a'] })]);
  });

  it('is empty when there are none', () => {
    expect(sealedRoomWarnings([issue({ code: 'zone-missing' })])).toEqual([]);
  });
});
