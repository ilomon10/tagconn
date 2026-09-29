import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// win32 has no O_NOFOLLOW / O_NONBLOCK: simulate that by removing both from fs.constants.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, constants: { ...actual.constants, O_NOFOLLOW: undefined, O_NONBLOCK: undefined } };
});

const { createReadState, readTranscriptUsage } = await import('../transcripts.parser.js');

const LIMITS = { maxLineBytes: 1024 * 1024, maxFileBytes: 256 * 1024 * 1024 };
const line = `${JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'x', usage: { input_tokens: 1, output_tokens: 2 } } })}\n`;
const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'transcript-nonofollow-'));

describe('readTranscriptUsage without O_NOFOLLOW (win32)', () => {
  it('still reads a regular file inside projectsDir', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'p'));
    const file = join(dir, 'p', 's.jsonl');
    writeFileSync(file, line);
    expect(readTranscriptUsage(file, createReadState(), dir, LIMITS)).toMatchObject({ messages: 1, outputTokens: 2 });
  });

  it('refuses a symlinked leaf (lstat guard replaces the flag), even one pointing inside projectsDir', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'p'));
    const real = join(dir, 'p', 'real.jsonl');
    writeFileSync(real, line);
    const link = join(dir, 'p', 'link.jsonl');
    symlinkSync(real, link);
    expect(readTranscriptUsage(link, createReadState(), dir, LIMITS)).toBeUndefined();
  });

  it('refuses a missing file without throwing', () => {
    const dir = tmp();
    expect(readTranscriptUsage(join(dir, 'nope.jsonl'), createReadState(), dir, LIMITS)).toBeUndefined();
  });
});
