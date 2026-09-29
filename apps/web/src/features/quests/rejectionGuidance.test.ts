import { describe, expect, it } from 'vitest';
import { RUN_END_REASONS, type RunEndReason } from '@tagconn/shared';
import { guidanceForEndReason, guidanceForError } from './rejectionGuidance';

describe('guidanceForEndReason', () => {
  it('returns undefined for no reason (a plain success, or still in flight)', () => {
    expect(guidanceForEndReason(undefined)).toBeUndefined();
  });

  it('has a non-empty entry for every RunEndReason (exhaustive)', () => {
    for (const reason of RUN_END_REASONS) {
      const text = guidanceForEndReason(reason);
      expect(text, `missing guidance for "${reason}"`).toBeTruthy();
    }
  });

  it.each<[RunEndReason, RegExp]>([
    ['dir_not_allowed', /allowed project directories/i],
    ['dir_not_trusted', /trust dialog/i],
    ['mode_not_allowed', /permission mode/i],
    ['tool_not_allowed', /allowlist/i],
    ['isolation_unavailable', /systemd user scope/i],
    ['resume_not_allowed', /resume the earlier session/i],
    ['capability_missing', /setting-sources/i],
    ['output_cap', /output than the configured cap/i],
    ['invalid_command', /malformed/i],
  ])('%s maps to human guidance matching %s', (reason, pattern) => {
    expect(guidanceForEndReason(reason)).toMatch(pattern);
  });
});

describe('guidanceForError', () => {
  it('maps a "runner_disabled: ..." prefixed error to the enable-the-runner guidance', () => {
    expect(guidanceForError('runner_disabled: settings.runner.enabled is false')).toMatch(/OFFICE_RUNNER__ENABLED=true/);
  });

  it('maps a "resume_not_allowed: ..." prefixed error the same way as the end-reason table', () => {
    expect(guidanceForError("resume_not_allowed: this run's session id was never confirmed by its own init event")).toMatch(/resume the earlier session/i);
  });

  it('recognizes "No verified runner is connected" without a reason prefix', () => {
    expect(guidanceForError('No verified runner is connected')).toMatch(/pnpm office:runner/);
  });

  it('recognizes "Run queue is full ..."', () => {
    expect(guidanceForError('Run queue is full (runner.maxQueued)')).toMatch(/queue is full/i);
  });

  it('falls back to the raw (already client-safe) message for anything unrecognized', () => {
    expect(guidanceForError('Unknown heroId "h-x"')).toBe('Unknown heroId "h-x"');
  });
});

describe('Windows guidance', () => {
  it('uses Windows text for isolation_unavailable, mode_not_allowed and tool_not_allowed on win32', () => {
    expect(guidanceForEndReason('isolation_unavailable', 'win32')).toMatch(/On Windows, quests can't use Bash or PowerShell/);
    expect(guidanceForEndReason('mode_not_allowed', 'win32')).toMatch(/Windows caps quests at 'accept edits'/);
    expect(guidanceForEndReason('tool_not_allowed', 'win32')).toMatch(/Bash or PowerShell/);
  });

  it('keeps the systemd text on linux or unknown platforms', () => {
    expect(guidanceForEndReason('isolation_unavailable', 'linux')).toMatch(/systemd user scope/);
    expect(guidanceForEndReason('isolation_unavailable')).toMatch(/systemd user scope/);
  });

  it('leaves unrelated reasons unchanged on win32', () => {
    expect(guidanceForEndReason('timeout', 'win32')).toBe(guidanceForEndReason('timeout'));
  });

  it('applies to prefixed errors too', () => {
    expect(guidanceForError('mode_not_allowed: auto', 'win32')).toMatch(/Windows caps/);
    expect(guidanceForError('mode_not_allowed: auto', 'linux')).toMatch(/permission mode/);
  });
});
