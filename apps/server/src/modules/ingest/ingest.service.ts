import type { HookPayload } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { redactPayload } from './redact.js';

export type IngestResult = { accepted: true } | { accepted: false; reason: string };

export class IngestService {
  constructor(private readonly deps: Deps<'settings' | 'bus'>) {}

  /** Filters, redacts and publishes one hook payload on the bus (synchronously). */
  ingest(raw: HookPayload, ts = Date.now()): IngestResult {
    const { ingest } = this.deps.settings.get();
    if (!ingest.enabledEvents.includes(raw.hook_event_name)) return { accepted: false, reason: 'event disabled' };

    // Redact the whole payload (message, unknown passthrough keys, everything) before it is ever
    // stored or emitted; downstream bubbles/summaries all read from this same redacted object.
    const payload = redactPayload(raw as unknown as Record<string, unknown>, ingest.redactPatterns) as unknown as HookPayload;

    this.deps.bus.emit('hook.received', {
      payload,
      ts,
      projectId: '',
      sessionId: payload.session_id,
      agentId: '',
      storePayload: ingest.storeToolPayloads,
    });
    return { accepted: true };
  }
}
