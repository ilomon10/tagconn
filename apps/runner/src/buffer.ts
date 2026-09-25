// Bounded buffers (docs/design/runner-and-helpdesk.md §2.5 "Caps" / §2.7): a per-run events+bytes cap
// that ends the run with `output_cap`, and an offline replay queue (while the /runner socket is
// disconnected) bounded the same way, dropping the OLDEST entry and reporting one notice.

import type { RunEventEnvelope } from '@tagconn/shared';

function envelopeBytes(e: RunEventEnvelope): number {
  return Buffer.byteLength(JSON.stringify(e), 'utf8');
}

export interface RunOutputCap {
  maxEvents: number;
  maxEventBytes: number;
}

export interface RunOutputCapState {
  events: number;
  bytes: number;
}

export function createOutputCapState(): RunOutputCapState {
  return { events: 0, bytes: 0 };
}

/**
 * Call before forwarding one event; mutates `state`. Returns 'ok' while under both caps, 'capped' the
 * first time either cap is crossed (the caller emits one notice then stops the run with `output_cap`),
 * and 'over' after that (the caller drops silently — the run is already stopping).
 */
export function checkOutputCap(state: RunOutputCapState, cap: RunOutputCap, eventBytes: number): 'ok' | 'capped' | 'over' {
  const wasOver = state.events > cap.maxEvents || state.bytes > cap.maxEventBytes;
  state.events += 1;
  state.bytes += eventBytes;
  const isOver = state.events > cap.maxEvents || state.bytes > cap.maxEventBytes;
  if (!isOver) return 'ok';
  return wasOver ? 'over' : 'capped';
}

export interface OfflineQueue {
  push(envelope: RunEventEnvelope): { dropped: boolean };
  drain(): RunEventEnvelope[];
  size: () => number;
}

/**
 * FIFO queue of events accumulated while the runner<->server socket is disconnected, replayed on
 * reconnect. Bounded by BOTH event count and total byte size; past either cap, the OLDEST entry is
 * evicted to make room (never the newest — a replay should keep the most recent context).
 */
export function createOfflineQueue(maxEvents: number, maxBytes: number): OfflineQueue {
  const items: { envelope: RunEventEnvelope; bytes: number }[] = [];
  let totalBytes = 0;

  function evictUntilWithinCaps(): boolean {
    let evicted = false;
    while (items.length > maxEvents || totalBytes > maxBytes) {
      const oldest = items.shift();
      if (!oldest) break;
      totalBytes -= oldest.bytes;
      evicted = true;
    }
    return evicted;
  }

  function push(envelope: RunEventEnvelope): { dropped: boolean } {
    const bytes = envelopeBytes(envelope);
    items.push({ envelope, bytes });
    totalBytes += bytes;
    const dropped = evictUntilWithinCaps();
    return { dropped };
  }

  function drain(): RunEventEnvelope[] {
    const out = items.map((i) => i.envelope);
    items.length = 0;
    totalBytes = 0;
    return out;
  }

  return { push, drain, size: () => items.length };
}
