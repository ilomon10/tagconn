import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import { describe, expect, it } from 'vitest';
import { createReadState, ingestChunk, readTranscriptUsage, summarize, type TranscriptLimits } from '../transcripts.parser.js';

const assistantLine = (id: string, usage: Record<string, number>, model = 'claude-sonnet-5') =>
  `${JSON.stringify({ type: 'assistant', message: { id, model, usage } })}\n`;

const USAGE_A = { input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
const USAGE_A2 = { input_tokens: 2, output_tokens: 25, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
const USAGE_B = { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 200, cache_creation_input_tokens: 50 };

/** Mirrors `transcripts.{maxLineBytes,maxFileBytes}`'s schema defaults, generous enough to be a no-op
 *  in tests that aren't specifically exercising the caps. */
const LIMITS: TranscriptLimits = { maxLineBytes: 1024 * 1024, maxFileBytes: 256 * 1024 * 1024 };

describe('transcript parser: line ingestion', () => {
  it('dedupes streaming chunks of the same message id, keeping the last usage', () => {
    const state = createReadState();
    ingestChunk(state, assistantLine('msg1', USAGE_A) + assistantLine('msg1', USAGE_A2), LIMITS.maxLineBytes);
    const usage = summarize(state);
    expect(usage).toMatchObject({ messages: 1, outputTokens: 25, inputTokens: 2 });
  });

  it('sums distinct messages and takes contextTokens/model from the latest one', () => {
    const state = createReadState();
    ingestChunk(state, assistantLine('msg1', USAGE_A, 'claude-opus-5') + assistantLine('msg2', USAGE_B, 'claude-sonnet-5'), LIMITS.maxLineBytes);
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
    ingestChunk(state, full + partial, LIMITS.maxLineBytes);
    expect(summarize(state)).toMatchObject({ messages: 1 });
    expect(state.leftover).toBe(partial);
    // Completing the line in the next chunk parses it correctly.
    const rest = `${JSON.stringify({ type: 'assistant', message: { id: 'msg2', usage: USAGE_B } })}`.slice(20);
    ingestChunk(state, `${rest}\n`, LIMITS.maxLineBytes);
    expect(summarize(state)).toMatchObject({ messages: 2 });
  });

  it('ignores malformed lines and non-assistant/no-usage lines', () => {
    const state = createReadState();
    ingestChunk(
      state,
      `not json at all\n${JSON.stringify({ type: 'user', message: { id: 'x' } })}\n${JSON.stringify({ type: 'assistant', message: { id: 'no-usage' } })}\n${assistantLine('msg1', USAGE_A)}`,
      LIMITS.maxLineBytes,
    );
    expect(summarize(state)).toMatchObject({ messages: 1, inputTokens: 2 });
  });

  it('returns undefined when nothing has been seen yet', () => {
    const state = createReadState();
    expect(summarize(state)).toBeUndefined();
    ingestChunk(state, '\n   \n', LIMITS.maxLineBytes);
    expect(summarize(state)).toBeUndefined();
  });

  it('clamps out-of-range counts and strips/truncates a hostile model name', () => {
    const state = createReadState();
    const hostileModel = `claude${'x'.repeat(100)}<script>`;
    ingestChunk(
      state,
      `${JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg1',
          model: hostileModel,
          usage: { input_tokens: -5, output_tokens: Number.MAX_SAFE_INTEGER * 4, cache_read_input_tokens: Number.NaN, cache_creation_input_tokens: 0 },
        },
      })}\n`,
      LIMITS.maxLineBytes,
    );
    const usage = summarize(state);
    expect(usage?.inputTokens).toBe(0); // clamped to >= 0
    expect(usage?.outputTokens).toBe(Number.MAX_SAFE_INTEGER); // clamped to <= MAX_SAFE_INTEGER
    expect(usage?.cacheReadTokens).toBe(0); // NaN -> 0
    expect(usage?.model?.length).toBeLessThanOrEqual(64);
    expect(usage?.model).not.toMatch(/[<>]/); // only [\w.:@/-] survives
  });

  it('caps a partial trailing line at maxLineBytes instead of buffering it forever', () => {
    const state = createReadState();
    // Large enough to hold one normal assistant line (~180 chars) comfortably, tiny next to the 10k
    // garbage chunks below.
    const maxLineBytes = 256;
    // A huge unterminated line (simulating a sparse/adversarial write with no '\n' yet): must not grow
    // `leftover` past the cap.
    ingestChunk(state, 'x'.repeat(10_000), maxLineBytes);
    expect(state.leftover.length).toBeLessThanOrEqual(maxLineBytes);
    expect(state.skippingLongLine).toBe(true);

    // More of the same still-oversized, still-unterminated line: stays capped, still skipping.
    ingestChunk(state, 'y'.repeat(10_000), maxLineBytes);
    expect(state.leftover.length).toBeLessThanOrEqual(maxLineBytes);
    expect(state.skippingLongLine).toBe(true);

    // The line finally ends and a normal line follows: resyncs cleanly on the next '\n'.
    ingestChunk(state, `\n${assistantLine('msg1', USAGE_A)}`, maxLineBytes);
    expect(state.skippingLongLine).toBe(false);
    expect(summarize(state)).toMatchObject({ messages: 1, inputTokens: USAGE_A.input_tokens });
  });

  it("the per-file decoder assembles a multi-byte UTF-8 character split exactly across a chunk boundary", () => {
    // Exercises the exact mechanism `readTranscriptUsage` uses (`state.decoder.decode(buf, {stream:
    // true})` per read): a naive per-chunk `Buffer.toString('utf8')` would decode each half of a split
    // multi-byte character as a replacement character (U+FFFD) instead of reassembling it.
    const state = createReadState();
    const text = 'prompt-😀-suffix';
    const full = Buffer.from(text, 'utf8');
    const emojiByteIndex = full.indexOf(Buffer.from('😀', 'utf8'));
    const splitAt = emojiByteIndex + 2; // mid-way through the emoji's 4-byte UTF-8 sequence
    const part1 = state.decoder.decode(full.subarray(0, splitAt), { stream: true });
    const part2 = state.decoder.decode(full.subarray(splitAt), { stream: true });
    expect(part1 + part2).toBe(text);
    expect(part1).not.toContain('�');
  });

  it('parses an assistant line whose text fields contain a multi-byte character split across a chunk boundary', () => {
    const state = createReadState();
    const full = Buffer.from(assistantLine('msg-😀', USAGE_A), 'utf8');
    const emojiByteIndex = full.indexOf(Buffer.from('😀', 'utf8'));
    const splitAt = emojiByteIndex + 2;
    ingestChunk(state, state.decoder.decode(full.subarray(0, splitAt), { stream: true }), LIMITS.maxLineBytes);
    ingestChunk(state, state.decoder.decode(full.subarray(splitAt), { stream: true }), LIMITS.maxLineBytes);
    expect(summarize(state)).toMatchObject({ messages: 1, inputTokens: USAGE_A.input_tokens });
  });
});

describe('transcript parser: incremental file reads', () => {
  const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'transcript-parser-'));
  const read = (path: string, state: ReturnType<typeof createReadState>, projectsDir: string, limits: TranscriptLimits = LIMITS, onCapped?: () => void) =>
    readTranscriptUsage(path, state, projectsDir, limits, onCapped);

  it('only re-parses newly appended bytes across repeated reads', () => {
    const dir = tmp();
    const file = join(dir, 't.jsonl');
    writeFileSync(file, assistantLine('msg1', USAGE_A));
    const state = createReadState();
    let usage = read(file, state, dir);
    expect(usage).toMatchObject({ messages: 1 });
    const offsetAfterFirst = state.offset;

    appendFileSync(file, assistantLine('msg2', USAGE_B));
    usage = read(file, state, dir);
    expect(usage).toMatchObject({ messages: 2, inputTokens: 5 });
    expect(state.offset).toBeGreaterThan(offsetAfterFirst);

    // Nothing new: same result, no re-parse needed.
    usage = read(file, state, dir);
    expect(usage).toMatchObject({ messages: 2 });
  });

  it('handles a partial trailing line across two file reads', () => {
    const dir = tmp();
    const file = join(dir, 't.jsonl');
    const line = assistantLine('msg1', USAGE_A);
    writeFileSync(file, line.slice(0, -1)); // no trailing newline yet: file is mid-write
    const state = createReadState();
    expect(read(file, state, dir)).toBeUndefined();
    expect(state.leftover.length).toBeGreaterThan(0);

    appendFileSync(file, '\n'); // the writer finishes the line
    expect(read(file, state, dir)).toMatchObject({ messages: 1 });
  });

  it('resets and re-parses from scratch when the file is truncated', () => {
    const dir = tmp();
    const file = join(dir, 't.jsonl');
    writeFileSync(file, assistantLine('msg1', USAGE_A) + assistantLine('msg2', USAGE_B));
    const state = createReadState();
    expect(read(file, state, dir)).toMatchObject({ messages: 2 });

    truncateSync(file, 0);
    writeFileSync(file, assistantLine('msgX', USAGE_A));
    const usage = read(file, state, dir);
    expect(usage).toMatchObject({ messages: 1, inputTokens: USAGE_A.input_tokens });
    expect(state.offset).toBeLessThan(assistantLine('msg1', USAGE_A).length + assistantLine('msg2', USAGE_B).length);
  });

  it('returns undefined (without throwing) for a file that does not exist yet', () => {
    const dir = tmp();
    const state = createReadState();
    expect(read(join(dir, 'missing.jsonl'), state, dir)).toBeUndefined();
  });

  it('a sparse file with no newlines is read without unbounded memory growth', () => {
    const dir = tmp();
    const file = join(dir, 't.jsonl');
    const maxLineBytes = 1024;
    writeFileSync(file, 'x'.repeat(50_000)); // no '\n' anywhere yet
    const state = createReadState();
    const usage = read(file, state, dir, { ...LIMITS, maxLineBytes });
    expect(usage).toBeUndefined();
    expect(state.leftover.length).toBeLessThanOrEqual(maxLineBytes);
    expect(state.offset).toBe(50_000); // still consumed/tracked the bytes, just didn't buffer them
  });

  it('stops tracking new bytes past maxFileBytes and warns exactly once', () => {
    const dir = tmp();
    const file = join(dir, 't.jsonl');
    const initial = assistantLine('msg1', USAGE_A);
    writeFileSync(file, initial);
    const state = createReadState();
    let capped = 0;
    // Exactly big enough for the first message, so it's the *next* growth that hits the cap.
    const limits: TranscriptLimits = { ...LIMITS, maxFileBytes: initial.length };
    let usage = read(file, state, dir, limits, () => capped++);
    expect(usage).toMatchObject({ messages: 1 }); // first read still got in under the cap
    expect(state.offset).toBe(initial.length);

    appendFileSync(file, assistantLine('msg2', USAGE_B));
    usage = read(file, state, dir, limits, () => capped++);
    usage = read(file, state, dir, limits, () => capped++);
    expect(usage).toMatchObject({ messages: 1 }); // msg2 never read: past the cap
    expect(capped).toBe(1); // warned once, not on every subsequent read
  });

  describe('containment: TOCTOU / symlink escapes are rejected on every read, not just at registration', () => {
    it('rejects a leaf that was swapped for a symlink after tracking started (TOCTOU)', () => {
      const projectsDir = tmp();
      const outside = tmp(); // sibling temp dir, outside projectsDir
      const file = join(projectsDir, 't.jsonl');
      const secret = join(outside, 'secret.jsonl');
      writeFileSync(file, assistantLine('msg1', USAGE_A));
      writeFileSync(secret, assistantLine('leaked', USAGE_B));
      const state = createReadState();
      expect(read(file, state, projectsDir)).toMatchObject({ messages: 1 });

      // Attacker swaps the tracked path for a symlink pointing outside projectsDir, then the file grows.
      rmSync(file);
      symlinkSync(secret, file);
      appendFileSync(secret, assistantLine('leaked2', USAGE_B));

      const usage = read(file, state, projectsDir);
      expect(usage).toMatchObject({ messages: 1 }); // unchanged: the symlinked leaf is never opened
    });

    it('rejects a file reached through a directory symlink pointing outside projectsDir', () => {
      const projectsDir = tmp();
      const outsideRoot = tmp();
      const realDir = join(outsideRoot, 'proj-slug');
      mkdirSync(realDir, { recursive: true });
      const real = join(realDir, 't.jsonl');
      writeFileSync(real, assistantLine('leaked', USAGE_A));
      const linkedDir = join(projectsDir, 'proj-slug'); // looks like it's under projectsDir lexically
      symlinkSync(realDir, linkedDir);
      const candidate = join(linkedDir, 't.jsonl');

      const state = createReadState();
      expect(read(candidate, state, projectsDir)).toBeUndefined();
    });

    it('accepts a real file reached through a symlinked projectsDir root (realpaths both sides)', () => {
      const realRoot = tmp();
      const linkedRoot = join(tmpdir(), `transcript-parser-link-${process.pid}-${Date.now()}`);
      symlinkSync(realRoot, linkedRoot);
      try {
        const file = join(linkedRoot, 't.jsonl');
        writeFileSync(file, assistantLine('msg1', USAGE_A));
        const state = createReadState();
        expect(read(file, state, linkedRoot)).toMatchObject({ messages: 1 });
      } finally {
        rmSync(linkedRoot);
      }
    });

    it.skipIf(platform !== 'linux')('rejects a FIFO planted at the tracked path (stat-then-open race)', () => {
      const projectsDir = tmp();
      const fifo = join(projectsDir, 't.jsonl');
      execFileSync('mkfifo', [fifo]);
      const state = createReadState();
      // O_NONBLOCK means this returns instead of hanging waiting for a reader/writer pair; fstat then
      // rejects it for not being a regular file.
      expect(read(fifo, state, projectsDir)).toBeUndefined();
    });
  });
});
