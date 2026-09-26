// Bounded buffers (docs/design/runner-and-helpdesk.md §2.5 "Caps" / §2.7): a per-run events+bytes cap
// that ends the run with `output_cap`, and an offline replay queue (while the /runner socket is
// disconnected) bounded the same way, dropping the OLDEST entry and reporting one notice.

import type { RunEnd, RunEventEnvelope } from '@tagconn/shared';

/**
 * SC5 H1 (L5): a run that ends while the socket is disconnected/unverified must not be silently lost
 * (main.ts previously only queued `run:event`, dropping `run:end` on the floor when offline — the
 * server would never learn the run finished). Both kinds share one FIFO so replay order is preserved.
 */
export type OfflineItem = { type: 'event'; envelope: RunEventEnvelope } | { type: 'end'; end: RunEnd };

function itemBytes(item: OfflineItem): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
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
  pushEvent(envelope: RunEventEnvelope): { dropped: boolean };
  pushEnd(end: RunEnd): { dropped: boolean };
  drain(): OfflineItem[];
  size: () => number;
}

/**
 * FIFO queue of events (and run-ends) accumulated while the runner<->server socket is disconnected or
 * unverified, replayed on the next verified connection. Bounded by BOTH item count and total byte
 * size; past either cap, the OLDEST entry is evicted to make room (never the newest — a replay should
 * keep the most recent context).
 */
export function createOfflineQueue(maxEvents: number, maxBytes: number): OfflineQueue {
  const items: { item: OfflineItem; bytes: number }[] = [];
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

  function push(item: OfflineItem): { dropped: boolean } {
    const bytes = itemBytes(item);
    items.push({ item, bytes });
    totalBytes += bytes;
    const dropped = evictUntilWithinCaps();
    return { dropped };
  }

  function drain(): OfflineItem[] {
    const out = items.map((i) => i.item);
    items.length = 0;
    totalBytes = 0;
    return out;
  }

  return {
    pushEvent: (envelope) => push({ type: 'event', envelope }),
    pushEnd: (end) => push({ type: 'end', end }),
    drain,
    size: () => items.length,
  };
}
