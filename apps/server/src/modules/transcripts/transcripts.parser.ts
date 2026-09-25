import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { TokenUsage } from '@tagconn/shared';

/** One assistant message's usage, keyed by message.id (streaming chunks repeat the same id). */
export interface UsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model?: string;
}

export interface TranscriptReadState {
  /** Bytes already consumed from the file. */
  offset: number;
  /** Trailing partial line carried over from the last read (the file may still be mid-write). */
  leftover: string;
  /** message.id -> latest usage seen for it. */
  usageById: Map<string, UsageEntry>;
  /** message.id most recently seen, by file order (defines "latest" for contextTokens/model). */
  lastMessageId?: string;
}

export const createReadState = (): TranscriptReadState => ({ offset: 0, leftover: '', usageById: new Map() });

const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Parses complete lines out of `state.leftover + chunk`, updating `state.usageById`/`lastMessageId` for
 * every `type: "assistant"` line whose `message.usage` is present. Any trailing partial line (the file
 * was read mid-write) is kept in `state.leftover` for the next call. Malformed lines are ignored.
 */
export function ingestChunk(state: TranscriptReadState, chunk: string): void {
  const lines = (state.leftover + chunk).split('\n');
  state.leftover = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // malformed line; the transcript is written by Claude Code but never fully trusted
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const rec = parsed as Record<string, unknown>;
    if (rec.type !== 'assistant') continue;
    const message = rec.message;
    if (!message || typeof message !== 'object') continue;
    const m = message as Record<string, unknown>;
    const usage = m.usage;
    const id = m.id;
    if (!usage || typeof usage !== 'object' || typeof id !== 'string') continue;
    const u = usage as Record<string, unknown>;
    state.usageById.set(id, {
      inputTokens: asNumber(u.input_tokens),
      outputTokens: asNumber(u.output_tokens),
      cacheReadTokens: asNumber(u.cache_read_input_tokens),
      cacheCreationTokens: asNumber(u.cache_creation_input_tokens),
      model: typeof m.model === 'string' ? m.model : undefined,
    });
    state.lastMessageId = id; // last-seen-by-file-order id, even if it was already in the map
  }
}

/** Sums every distinct message's usage; contextTokens/model come from the latest message (by file order). */
export function summarize(state: TranscriptReadState): TokenUsage | undefined {
  if (state.usageById.size === 0) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const e of state.usageById.values()) {
    inputTokens += e.inputTokens;
    outputTokens += e.outputTokens;
    cacheReadTokens += e.cacheReadTokens;
    cacheCreationTokens += e.cacheCreationTokens;
  }
  const latest = state.lastMessageId ? state.usageById.get(state.lastMessageId) : undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    messages: state.usageById.size,
    contextTokens: latest ? latest.inputTokens + latest.cacheReadTokens + latest.cacheCreationTokens : 0,
    model: latest?.model,
  };
}

/** A debounce cycle should never need more than this; caps how much one read pulls into memory. */
const READ_CHUNK_MAX = 8 * 1024 * 1024;

/**
 * Reads whatever bytes were appended to `path` since `state.offset`, updates `state` in place, and
 * returns the summarized usage (or the previous summary if nothing new parsed, or undefined if the
 * file doesn't exist yet / has no usage lines yet). A file smaller than `state.offset` (rotated or
 * truncated) resets tracking and re-parses from the start.
 */
export function readTranscriptUsage(path: string, state: TranscriptReadState): TokenUsage | undefined {
  if (!existsSync(path)) return summarize(state);
  const size = statSync(path).size;
  if (size < state.offset) {
    state.offset = 0;
    state.leftover = '';
    state.usageById.clear();
    state.lastMessageId = undefined;
  }
  const length = Math.min(size - state.offset, READ_CHUNK_MAX);
  if (length <= 0) return summarize(state);
  const buf = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, length, state.offset);
  } finally {
    closeSync(fd);
  }
  state.offset += length;
  // A multi-byte UTF-8 character split exactly across this read's byte boundary would decode as a
  // replacement character here; accepted as a rare, self-correcting edge case (next read moves past it).
  ingestChunk(state, buf.toString('utf8'));
  return summarize(state);
}
