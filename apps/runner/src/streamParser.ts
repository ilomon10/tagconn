// stream-json line handling (docs/design/runner-and-helpdesk.md §2.5): a bounded line splitter over
// `claude`'s stdout, and a mapper from one parsed CLI line to zero or more `RunEvent`s.

import type { RunEvent } from '@tagconn/shared';

export interface LineSplitResult {
  lines: string[];
  /** True if this push (or the accumulated partial line) exceeded maxLineBytes and was dropped. */
  overflowed: boolean;
}

export interface LineSplitter {
  push(chunk: string): LineSplitResult;
  /** Call at stream end (process exit) to flush any trailing line with no terminating newline. */
  flush(): LineSplitResult;
}

/**
 * Splits a byte/char stream into trimmed non-empty lines. The partial-line buffer never grows past
 * `maxLineBytes`: once it does, the runner drops the rest of that line (and the line itself) and
 * reports one overflow per affected push, resuming clean line splitting from the next `\n`.
 */
export function createLineSplitter(maxLineBytes: number): LineSplitter {
  let buf = '';
  let dropRestOfCurrentLine = false;

  function push(chunk: string): LineSplitResult {
    buf += chunk;
    const lines: string[] = [];
    let overflowed = false;
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const rawLine = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (dropRestOfCurrentLine) {
        dropRestOfCurrentLine = false;
        overflowed = true;
        continue;
      }
      if (Buffer.byteLength(rawLine, 'utf8') > maxLineBytes) {
        overflowed = true;
        continue;
      }
      const trimmed = rawLine.trim();
      if (trimmed) lines.push(trimmed);
    }
    if (Buffer.byteLength(buf, 'utf8') > maxLineBytes) {
      dropRestOfCurrentLine = true;
      buf = '';
      overflowed = true;
    }
    return { lines, overflowed };
  }

  function flush(): LineSplitResult {
    const trimmed = buf.trim();
    const wasOverflowed = dropRestOfCurrentLine;
    buf = '';
    dropRestOfCurrentLine = false;
    if (wasOverflowed || !trimmed) return { lines: [], overflowed: wasOverflowed };
    return { lines: [trimmed], overflowed: false };
  }

  return { push, flush };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === 'string' ? x : typeof x === 'object' && x && 'name' in x ? String((x as { name: unknown }).name) : String(x)));
}

function toolInputPreview(input: unknown): string {
  if (input === undefined) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function toolResultPreview(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : typeof c === 'object' && c && 'text' in c ? String((c as { text: unknown }).text) : ''))
      .join('');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

/**
 * Maps one parsed stream-json line (already `JSON.parse`d) to zero or more `RunEvent`s. Unknown or
 * malformed shapes yield no events (never throw); the caller may still want to log them.
 */
export function mapClaudeLine(line: unknown, previewChars: number): RunEvent[] {
  if (typeof line !== 'object' || line === null) return [];
  const obj = line as Record<string, unknown>;
  const type = obj.type;

  if (type === 'system' && obj.subtype === 'init') {
    const sessionId = obj.session_id ?? obj.sessionId;
    if (typeof sessionId !== 'string') return [];
    return [
      {
        kind: 'init',
        sessionId,
        model: typeof obj.model === 'string' ? obj.model : undefined,
        cwd: typeof obj.cwd === 'string' ? obj.cwd : undefined,
        permissionMode: typeof obj.permissionMode === 'string' ? obj.permissionMode : undefined,
        tools: asStringArray(obj.tools),
        mcpServers: asStringArray(obj.mcp_servers ?? obj.mcpServers),
      },
    ];
  }

  if (type === 'stream_event') {
    const event = obj.event as Record<string, unknown> | undefined;
    const delta = event?.delta as Record<string, unknown> | undefined;
    if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return [{ kind: 'text', partial: true, text: truncate(delta.text, 64_000) }];
    }
    return [];
  }

  if (type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return [];
    const events: RunEvent[] = [];
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        events.push({ kind: 'text', partial: false, text: truncate(block.text, 64_000) });
      } else if (block.type === 'tool_use') {
        events.push({
          kind: 'tool_use',
          toolUseId: truncate(String(block.id ?? ''), 200),
          name: truncate(String(block.name ?? ''), 200),
          inputPreview: truncate(toolInputPreview(block.input), previewChars),
        });
      }
    }
    return events;
  }

  if (type === 'user') {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return [];
    const events: RunEvent[] = [];
    for (const block of content as ContentBlock[]) {
      if (block.type === 'tool_result') {
        events.push({
          kind: 'tool_result',
          toolUseId: truncate(String(block.tool_use_id ?? ''), 200),
          isError: block.is_error === true,
          preview: truncate(toolResultPreview(block.content), previewChars),
        });
      }
    }
    return events;
  }

  if (type === 'result') {
    const usageRaw = obj.usage as Record<string, unknown> | undefined;
    return [
      {
        kind: 'result',
        subtype: truncate(String(obj.subtype ?? ''), 60),
        isError: obj.is_error === true,
        text: typeof obj.result === 'string' ? truncate(obj.result, 64_000) : undefined,
        sessionId: typeof (obj.session_id ?? obj.sessionId) === 'string' ? (obj.session_id as string) ?? (obj.sessionId as string) : undefined,
        costUsd: typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
        durationMs: typeof obj.duration_ms === 'number' ? obj.duration_ms : undefined,
        numTurns: typeof obj.num_turns === 'number' ? obj.num_turns : undefined,
        usage: usageRaw
          ? {
              inputTokens: Number(usageRaw.input_tokens ?? 0),
              outputTokens: Number(usageRaw.output_tokens ?? 0),
              cacheReadTokens: Number(usageRaw.cache_read_input_tokens ?? 0),
              cacheCreationTokens: Number(usageRaw.cache_creation_input_tokens ?? 0),
            }
          : undefined,
      },
    ];
  }

  return [];
}

/** stderr lines become notices (bounded to maxStderrLines by the caller). */
export function stderrNotice(line: string): RunEvent {
  return { kind: 'notice', level: 'warn', message: truncate(line, 4_000) };
}
