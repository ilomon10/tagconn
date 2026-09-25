import { closeSync, constants as fsConstants, fstatSync, openSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { platform } from 'node:process';
import { TextDecoder } from 'node:util';
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
  /** Set while dropping the remainder of a line that already exceeded maxLineBytes, until the next '\n'. */
  skippingLongLine: boolean;
  /** Per-file UTF-8 decoder, so a multi-byte character split across two reads decodes correctly instead
   *  of producing a replacement character (each read is fed through the same stateful decoder). */
  decoder: TextDecoder;
  /** Set once `readTranscriptUsage` stops tracking new bytes past `transcripts.maxFileBytes`, so the
   *  caller can warn exactly once instead of on every read. */
  fileBytesCapped: boolean;
}

export const createReadState = (): TranscriptReadState => ({
  offset: 0,
  leftover: '',
  usageById: new Map(),
  skippingLongLine: false,
  decoder: new TextDecoder('utf-8'),
  fileBytesCapped: false,
});

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const asNumber = (v: unknown): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return Math.min(Math.max(n, 0), MAX_SAFE);
};

/** A transcript-supplied model name is untrusted: keep it short and printable-only. */
const MODEL_MAX = 64;
const MODEL_CHAR_RE = /[^\w.:@/-]/g;
const asModel = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const cleaned = v.replace(MODEL_CHAR_RE, '').slice(0, MODEL_MAX);
  return cleaned || undefined;
};

/** Parses one already-delimited line (no trailing '\n'). Malformed/irrelevant lines are ignored. */
function parseLine(state: TranscriptReadState, line: string): void {
  if (!line.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // malformed line; the transcript is written by Claude Code but never fully trusted
  }
  if (!parsed || typeof parsed !== 'object') return;
  const rec = parsed as Record<string, unknown>;
  if (rec.type !== 'assistant') return;
  const message = rec.message;
  if (!message || typeof message !== 'object') return;
  const m = message as Record<string, unknown>;
  const usage = m.usage;
  const id = m.id;
  if (!usage || typeof usage !== 'object' || typeof id !== 'string') return;
  const u = usage as Record<string, unknown>;
  state.usageById.set(id, {
    inputTokens: asNumber(u.input_tokens),
    outputTokens: asNumber(u.output_tokens),
    cacheReadTokens: asNumber(u.cache_read_input_tokens),
    cacheCreationTokens: asNumber(u.cache_creation_input_tokens),
    model: asModel(m.model),
  });
  state.lastMessageId = id; // last-seen-by-file-order id, even if it was already in the map
}

/**
 * Parses complete lines out of `state.leftover + chunk`, updating `state.usageById`/`lastMessageId` for
 * every `type: "assistant"` line whose `message.usage` is present. Any trailing partial line (the file
 * was read mid-write) is kept in `state.leftover` for the next call, capped at `maxLineBytes`: a line
 * (partial or complete) longer than that is dropped instead of buffered forever, which would otherwise
 * let a single unterminated write grow `leftover` without bound (memory DoS).
 */
export function ingestChunk(state: TranscriptReadState, chunk: string, maxLineBytes: number): void {
  let buf = state.leftover + chunk;
  state.leftover = '';
  for (;;) {
    const nl = buf.indexOf('\n');
    if (state.skippingLongLine) {
      if (nl < 0) {
        buf = ''; // still no end in sight: keep discarding, nothing to buffer
        break;
      }
      buf = buf.slice(nl + 1);
      state.skippingLongLine = false;
      continue;
    }
    if (nl < 0) {
      if (buf.length > maxLineBytes) {
        // An in-progress line already exceeds the cap with no newline yet: drop what we have and
        // resync on the next '\n' instead of letting `leftover` grow unbounded.
        state.skippingLongLine = true;
        buf = '';
      }
      break;
    }
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.length > maxLineBytes) continue; // drop this oversized (but complete) line
    parseLine(state, line);
  }
  state.leftover = buf;
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

export interface TranscriptLimits {
  /** `transcripts.maxLineBytes`: see `ingestChunk`. */
  maxLineBytes: number;
  /** `transcripts.maxFileBytes`: stop tracking new bytes of a file past this size. */
  maxFileBytes: number;
}

/**
 * Resolves the real, symlink-free path of an already-open fd, binding the containment check to the
 * exact file description we're about to read rather than re-walking `path` from scratch (which would
 * reopen the TOCTOU window this exists to close: a directory component could be swapped for a symlink
 * between `openSync` and the check). On Linux, `/proc/self/fd/<fd>` is a magic link maintained by the
 * kernel for the open file description, so this is race-free. Elsewhere (no /proc), falls back to
 * realpath-ing `path` directly: a narrower guarantee, but still far better than the lexical check this
 * replaces.
 */
function realFdPath(fd: number, fallbackPath: string): string {
  if (platform === 'linux') {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      // fall through to the realpath fallback below
    }
  }
  return realpathSync(fallbackPath);
}

/**
 * Reads whatever bytes were appended to `path` since `state.offset`, updates `state` in place, and
 * returns the summarized usage (or the previous summary if nothing new parsed, or undefined if the
 * file doesn't exist yet / has no usage lines yet). A file smaller than `state.offset` (rotated or
 * truncated) resets tracking and re-parses from the start.
 *
 * `path` is opened with `O_NOFOLLOW` (rejects a symlinked leaf outright — we never read through one,
 * even one pointing back inside `projectsDir`) and `O_NONBLOCK` (a FIFO planted at `path` is opened
 * without blocking the event loop instead of stat-then-open racing it). The opened fd is then required,
 * by its real resolved path (see `realFdPath`), to live under `realpathSync(projectsDir)` — re-checked
 * on every call, not just when the path was first registered, so a symlink swapped in after tracking
 * started (TOCTOU) is caught before its target is ever read.
 */
export function readTranscriptUsage(path: string, state: TranscriptReadState, projectsDir: string, limits: TranscriptLimits, onCapped?: () => void): TokenUsage | undefined {
  let root: string;
  try {
    root = realpathSync(projectsDir);
  } catch {
    return summarize(state); // projectsDir doesn't exist (yet): nothing can be safely read
  }

  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return summarize(state); // missing, a symlink leaf, or otherwise unopenable: nothing new to read
  }

  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return summarize(state); // reject FIFOs/dirs/devices opened via the race window

    const real = realFdPath(fd, path);
    if (real !== root && !real.startsWith(root + sep)) return summarize(state); // escaped projectsDir

    const size = st.size;
    if (size < state.offset) {
      state.offset = 0;
      state.leftover = '';
      state.usageById.clear();
      state.lastMessageId = undefined;
      state.skippingLongLine = false;
      state.fileBytesCapped = false;
    }
    if (state.offset >= limits.maxFileBytes) {
      if (!state.fileBytesCapped) {
        state.fileBytesCapped = true;
        onCapped?.();
      }
      return summarize(state);
    }
    const length = Math.min(size - state.offset, READ_CHUNK_MAX, limits.maxFileBytes - state.offset);
    if (length <= 0) return summarize(state);
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, state.offset);
    state.offset += bytesRead;
    ingestChunk(state, state.decoder.decode(buf.subarray(0, bytesRead), { stream: true }), limits.maxLineBytes);
    return summarize(state);
  } finally {
    closeSync(fd);
  }
}
