import type { LogLine, ServiceId } from '@tagconn/shared';
import { redact } from './redact.ts';

export type LogService = ServiceId | 'supervisor';
export const RING_SIZE = 2000;

/** Per-service ring buffers of redacted lines, plus a live feed for `log.line` notifications. */
export class LogHub {
  private readonly rings = new Map<LogService, LogLine[]>();
  private readonly partial = new Map<string, string>();
  private readonly secrets = new Set<string>();

  constructor(
    private readonly onLine: (line: LogLine) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** A token whose exact value must never appear in a log line. */
  addSecret(value: string | undefined): void {
    if (value) this.secrets.add(value);
  }

  push(service: LogService, stream: LogLine['stream'], text: string): void {
    const line: LogLine = { service, ts: this.now(), stream, line: redact(text, this.secrets) };
    let ring = this.rings.get(service);
    if (!ring) this.rings.set(service, (ring = []));
    ring.push(line);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
    this.onLine(line);
  }

  /** Feeds a raw stdout/stderr chunk; complete lines are pushed, the tail waits for the next chunk. */
  feed(service: LogService, stream: 'stdout' | 'stderr', chunk: string): void {
    const key = `${service}:${stream}`;
    const text = (this.partial.get(key) ?? '') + chunk;
    const parts = text.split(/\r?\n/);
    this.partial.set(key, parts.pop() ?? '');
    for (const p of parts) if (p.length > 0) this.push(service, stream, p);
  }

  /** Pushes whatever is left of an unterminated last line (the child exited). */
  flush(service: LogService): void {
    for (const stream of ['stdout', 'stderr'] as const) {
      const key = `${service}:${stream}`;
      const rest = this.partial.get(key);
      this.partial.delete(key);
      if (rest) this.push(service, stream, rest);
    }
  }

  tail(service: LogService, lines: number): LogLine[] {
    const ring = this.rings.get(service) ?? [];
    return ring.slice(-lines);
  }
}
