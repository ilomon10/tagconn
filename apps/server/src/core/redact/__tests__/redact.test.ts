import { describe, expect, it } from 'vitest';
import { redactValue } from '../redact.js';

/**
 * `core/redact` is the ingest redactor moved here (M8 S2) so `modules/runs` can reuse it for run
 * event text and prompts. The full pattern-coverage suite still lives at
 * `modules/ingest/__tests__/redact.test.ts` (unchanged; it now exercises this file through the
 * `modules/ingest/redact.ts` re-export shim). This file only covers the run-event-shaped usage.
 */
describe('core/redact: reused for run events (M8 8k, S2)', () => {
  it('redacts a secret embedded in a RunEvent-shaped object without disturbing its structure', () => {
    const event = { kind: 'tool_result', toolUseId: 't1', isError: false, preview: 'token=Bearer abc.def-ghi_123 done' };
    const out = redactValue(event, []);
    expect(out).toMatchObject({ kind: 'tool_result', toolUseId: 't1', isError: false });
    expect((out as typeof event).preview).toContain('[redacted]');
    expect((out as typeof event).preview).not.toContain('abc.def-ghi_123');
  });

  it('redacts a secret pasted into a quest prompt string', () => {
    const prompt = 'please use aws key AKIAABCDEFGHIJKLMNOP to deploy';
    expect(redactValue(prompt, [])).toBe('please use aws key [redacted] to deploy');
  });

  it('still applies user-configured patterns (e.g. settings.ingest.redactPatterns) to run text', () => {
    const out = redactValue({ kind: 'text', partial: false, text: 'classified-42' }, ['classified-\\d+']);
    expect(out.text).toBe('[redacted]');
  });
});
