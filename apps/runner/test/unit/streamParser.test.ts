import { describe, expect, it } from 'vitest';
import { createLineSplitter, mapClaudeLine, stderrNotice } from '../../src/streamParser.js';

describe('createLineSplitter', () => {
  it('splits chunks arriving mid-line across multiple pushes', () => {
    const s = createLineSplitter(1024);
    expect(s.push('{"a":1}\n{"b":2').lines).toEqual(['{"a":1}']);
    expect(s.push('}\n').lines).toEqual(['{"b":2}']);
  });

  it('drops a line that exceeds maxLineBytes and reports one overflow, then resumes clean', () => {
    const s = createLineSplitter(16);
    const r1 = s.push(`${'x'.repeat(50)}\n`);
    expect(r1.lines).toEqual([]);
    expect(r1.overflowed).toBe(true);
    const r2 = s.push('short\n');
    expect(r2.lines).toEqual(['short']);
    expect(r2.overflowed).toBe(false);
  });

  it('handles a partial line itself growing past the cap before any newline arrives', () => {
    const s = createLineSplitter(10);
    const r1 = s.push('x'.repeat(5));
    expect(r1.overflowed).toBe(false);
    const r2 = s.push('x'.repeat(20));
    expect(r2.overflowed).toBe(true);
    // The still-pending overlong line's eventual terminator arrives later and is dropped too (it's the
    // same logical line), reported as one more overflow.
    const r3 = s.push('remainder\n');
    expect(r3.lines).toEqual([]);
    expect(r3.overflowed).toBe(true);
    // Once that terminator is consumed, splitting is clean again.
    const r4 = s.push('ok\n');
    expect(r4.lines).toEqual(['ok']);
  });

  it('flush() emits a trailing line with no terminating newline, or nothing if empty/overflowed', () => {
    const s = createLineSplitter(1024);
    s.push('{"trailing":true}');
    expect(s.flush().lines).toEqual(['{"trailing":true}']);

    const s2 = createLineSplitter(1024);
    expect(s2.flush().lines).toEqual([]);
  });

  it('ignores blank lines', () => {
    const s = createLineSplitter(1024);
    expect(s.push('\n\n{"x":1}\n\n').lines).toEqual(['{"x":1}']);
  });
});

describe('mapClaudeLine', () => {
  it('maps system/init to an init RunEvent with tools and mcp_servers', () => {
    const events = mapClaudeLine({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '/proj', model: 'sonnet', permissionMode: 'plan', tools: ['Read', 'Grep'], mcp_servers: [] }, 2000);
    expect(events).toEqual([{ kind: 'init', sessionId: 'sess-1', model: 'sonnet', cwd: '/proj', permissionMode: 'plan', tools: ['Read', 'Grep'], mcpServers: [] }]);
  });

  it('ignores a system line that is not subtype init', () => {
    expect(mapClaudeLine({ type: 'system', subtype: 'other' }, 2000)).toEqual([]);
  });

  it('maps a stream_event text delta to a partial text event', () => {
    const events = mapClaudeLine({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } } }, 2000);
    expect(events).toEqual([{ kind: 'text', partial: true, text: 'hi' }]);
  });

  it('maps assistant text and tool_use blocks', () => {
    const events = mapClaudeLine(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x' } }] } },
      2000,
    );
    expect(events).toEqual([
      { kind: 'text', partial: false, text: 'hello' },
      { kind: 'tool_use', toolUseId: 'tu1', name: 'Read', inputPreview: '{"file_path":"/x"}' },
    ]);
  });

  it('truncates tool_use inputPreview to previewChars', () => {
    const events = mapClaudeLine({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'x'.repeat(100) } }] } }, 10);
    expect((events[0] as { inputPreview: string }).inputPreview.length).toBe(10);
  });

  it('maps user tool_result blocks, including isError', () => {
    const events = mapClaudeLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'boom' }] } }, 2000);
    expect(events).toEqual([{ kind: 'tool_result', toolUseId: 'tu1', isError: true, preview: 'boom' }]);
  });

  it('maps result lines with usage', () => {
    const events = mapClaudeLine(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        session_id: 'sess-1',
        total_cost_usd: 0.01,
        duration_ms: 100,
        num_turns: 2,
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
      },
      2000,
    );
    expect(events).toEqual([
      { kind: 'result', subtype: 'success', isError: false, text: 'done', sessionId: 'sess-1', costUsd: 0.01, durationMs: 100, numTurns: 2, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 } },
    ]);
  });

  it('never throws on malformed or unknown input', () => {
    expect(mapClaudeLine(null, 2000)).toEqual([]);
    expect(mapClaudeLine('a string', 2000)).toEqual([]);
    expect(mapClaudeLine({ type: 'unknown_type' }, 2000)).toEqual([]);
    expect(mapClaudeLine({ type: 'assistant', message: { content: 'not-an-array' } }, 2000)).toEqual([]);
  });

  it('stderrNotice truncates to 4000 chars and is level warn', () => {
    const n = stderrNotice('x'.repeat(5000));
    expect(n.kind).toBe('notice');
    if (n.kind === 'notice') {
      expect(n.level).toBe('warn');
      expect(n.message.length).toBe(4000);
    }
  });
});
