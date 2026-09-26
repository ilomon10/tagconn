import { describe, expect, it } from 'vitest';
import { checkOutputCap, createOfflineQueue, createOutputCapState, type OfflineItem } from '../../src/buffer.js';
import type { RunEnd, RunEventEnvelope } from '@tagconn/shared';

function envelope(seq: number, text = 'x'): RunEventEnvelope {
  return { runId: 'r1', seq, ts: 1, event: { kind: 'text', partial: false, text } };
}

/** Extracts the event's seq from a drained event-typed OfflineItem (fails loudly on an end item). */
function seqOf(item: OfflineItem): number {
  if (item.type !== 'event') throw new Error('expected an event item');
  return item.envelope.seq;
}

function end(runId: string): RunEnd {
  return { runId, status: 'succeeded', reason: 'exit', exitCode: 0, signal: null };
}

describe('checkOutputCap', () => {
  it('returns ok while under both the event and byte caps', () => {
    const state = createOutputCapState();
    expect(checkOutputCap(state, { maxEvents: 10, maxEventBytes: 10_000 }, 100)).toBe('ok');
  });

  it('returns capped exactly once when a cap is first crossed, then over afterward', () => {
    const state = createOutputCapState();
    const cap = { maxEvents: 2, maxEventBytes: 10_000 };
    expect(checkOutputCap(state, cap, 10)).toBe('ok'); // 1
    expect(checkOutputCap(state, cap, 10)).toBe('ok'); // 2
    expect(checkOutputCap(state, cap, 10)).toBe('capped'); // 3: crosses maxEvents
    expect(checkOutputCap(state, cap, 10)).toBe('over'); // 4: already over
  });

  it('the byte cap crosses independently of the event cap', () => {
    const state = createOutputCapState();
    const cap = { maxEvents: 1000, maxEventBytes: 100 };
    expect(checkOutputCap(state, cap, 60)).toBe('ok');
    expect(checkOutputCap(state, cap, 60)).toBe('capped'); // 120 > 100
    expect(checkOutputCap(state, cap, 1)).toBe('over');
  });
});

describe('createOfflineQueue', () => {
  it('replays events in FIFO order via drain()', () => {
    const q = createOfflineQueue(10, 1_000_000);
    q.pushEvent(envelope(1));
    q.pushEvent(envelope(2));
    const drained = q.drain();
    expect(drained.map(seqOf)).toEqual([1, 2]);
  });

  it('drops the OLDEST entry once the event count cap is exceeded', () => {
    const q = createOfflineQueue(2, 1_000_000);
    q.pushEvent(envelope(1));
    q.pushEvent(envelope(2));
    const r = q.pushEvent(envelope(3));
    expect(r.dropped).toBe(true);
    expect(q.drain().map(seqOf)).toEqual([2, 3]);
  });

  it('drops the oldest entry once the byte cap is exceeded', () => {
    const bigText = 'x'.repeat(500);
    const maxBytes = JSON.stringify({ type: 'event', envelope: envelope(1, bigText) }).length + 10; // room for ~1 event
    const q = createOfflineQueue(1000, maxBytes);
    q.pushEvent(envelope(1, bigText));
    const r = q.pushEvent(envelope(2, bigText));
    expect(r.dropped).toBe(true);
    expect(q.drain().map(seqOf)).toEqual([2]);
  });

  it('drain() empties the queue', () => {
    const q = createOfflineQueue(10, 1_000_000);
    q.pushEvent(envelope(1));
    q.drain();
    expect(q.size()).toBe(0);
  });

  it('H1/L5: a run:end queued while offline is replayed too, in FIFO order with events', () => {
    const q = createOfflineQueue(10, 1_000_000);
    q.pushEvent(envelope(1));
    q.pushEnd(end('r1'));
    const drained = q.drain();
    expect(drained).toEqual([{ type: 'event', envelope: envelope(1) }, { type: 'end', end: end('r1') }]);
  });
});
