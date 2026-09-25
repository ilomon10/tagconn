import { appendFileSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReadState, ingestChunk, readTranscriptUsage, summarize } from '../transcripts.parser.js';

const assistantLine = (id: string, usage: Record<string, number>, model = 'claude-sonnet-5') =>
  `${JSON.stringify({ type: 'assistant', message: { id, model, usage } })}\n`;

const USAGE_A = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
const USAGE_A2 = { input_tokens: 2, output_tokens: 25, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
const USAGE_B = { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 };

describe('transcript parser: line ingestion', () => {
  it('dedupes streaming chunks of the same message id, keeping the last usage', () => {
    const state = createReadState();
    ingestChunk(state, assistantLine('msg1', USAGE_A) + assistantLine('msg1', USAGE_A2));
    const usage = summarize(state);
    expect(usage).toMatchObject({ messages: 1, outputTokens: 25, inputTokens: 2 });
  });

  it('sums distinct messages and takes contextTokens/model from the latest one', () => {
    const state = createReadState();
    ingestChunk(state, assistantLine('msg1', USAGE_A, 'claude-opus-5') + assistantLine('msg2', USAGE_B, 'claude-sonnet-5'));
    const usage = summarize(state);
    expect(usage).toMatchObject({
      messages: 2,
      inputTokens: 5,
      outputTokens: 15,
      cacheReadTokens: 300,
      cacheCreationTokens: 50,
      model: 'claude-sonnet-5', // latest message, not msg1
      contextTokens: USAGE_B.input_tokens + USAGE_B.cache_read_input_tokens + USAGE_B.cache_creation_input_tokens,
    });
  });

  it('keeps a partial trailing line for the next chunk instead of dropping/mis-parsing it', () => {
    const state = createReadState();
    const full = assistantLine('msg1', USAGE_A);
    const partial = `${JSON.stringify({ type: 'assistant', message: { id: 'msg2', usage: USAGE_B } })}`.slice(0, 20);
    ingestChunk(state, full + partial);
    expect(summarize(state)).toMatchObject({ messages: 1 });
    expect(state.leftover).toBe(partial);
    // Completing the line in the next chunk parses it correctly.
    const rest = `${JSON.stringify({ type: 'assistant', message: { id: 'msg2', usage: USAGE_B } })}`.slice(20);
    ingestChunk(state, `${rest}\n`);
    expect(summarize(state)).toMatchObject({ messages: 2 });
  });

  it('ignores malformed lines and non-assistant/no-usage lines', () => {
    const state = createReadState();
    ingestChunk(
      state,
      `not json at all\n${JSON.stringify({ type: 'user', message: { id: 'x' } })}\n${JSON.stringify({ type: 'assistant', message: { id: 'no-usage' } })}\n${assistantLine('msg1', USAGE_A)}`,
    );
    expect(summarize(state)).toMatchObject({ messages: 1, inputTokens: 2 });
  });

  it('returns undefined when nothing has been seen yet', () => {
    const state = createReadState();
    expect(summarize(state)).toBeUndefined();
    ingestChunk(state, '\n   \n');
    expect(summarize(state)).toBeUndefined();
  });
});

describe('transcript parser: incremental file reads', () => {
  const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'transcript-parser-'));

  it('only re-parses newly appended bytes across repeated reads', () => {
    const dir = tmp();
    const file = join(dir, 't.jsonl');
    writeFileSync(file, assistantLine('msg1', USAGE_A));
    const state = createReadState();
    let usage = readTranscriptUsage(file, state);
    expect(usage).toMatchObject({ messages: 1 });
    const offsetAfterFirst = state.offset;

    appendFileSync(file, assistantLine('msg2', USAGE_B));
    usage = readTranscriptUsage(file, state);
    expect(usage).toMatchObject({ messages: 2, inputTokens: 5 });
    expect(state.offset).toBeGreaterThan(offsetAfterFirst);

    // Nothing new: same result, no re-parse needed.
    usage = readTranscriptUsage(file, state);
    expect(usage).toMatchObject({ messages: 2 });
  });

  it('handles a partial trailing line across two file reads', () => {
    const dir = tmp();
    const file = join(dir, 't.jsonl');
    const line = assistantLine('msg1', USAGE_A);
    writeFileSync(file, line.slice(0, -1)); // no trailing newline yet: file is mid-write
    const state = createReadState();
    expect(readTranscriptUsage(file, state)).toBeUndefined();
    expect(state.leftover.length).toBeGreaterThan(0);

    appendFileSync(file, '\n'); // the writer finishes the line
    expect(readTranscriptUsage(file, state)).toMatchObject({ messages: 1 });
  });

  it('resets and re-parses from scratch when the file is truncated', () => {
    const dir = tmp();
    const file = join(dir, 't.jsonl');
    writeFileSync(file, assistantLine('msg1', USAGE_A) + assistantLine('msg2', USAGE_B));
    const state = createReadState();
    expect(readTranscriptUsage(file, state)).toMatchObject({ messages: 2 });

    truncateSync(file, 0);
    writeFileSync(file, assistantLine('msgX', USAGE_A));
    const usage = readTranscriptUsage(file, state);
    expect(usage).toMatchObject({ messages: 1, inputTokens: USAGE_A.input_tokens });
    expect(state.offset).toBeLessThan(assistantLine('msg1', USAGE_A).length + assistantLine('msg2', USAGE_B).length);
  });

  it('returns undefined (without throwing) for a file that does not exist yet', () => {
    const dir = tmp();
    const state = createReadState();
    expect(readTranscriptUsage(join(dir, 'missing.jsonl'), state)).toBeUndefined();
  });
});
