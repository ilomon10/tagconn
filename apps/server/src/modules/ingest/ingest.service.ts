import { type HookPayload, parseProjectPath, parseProjectRootHeader, parseProjectRootKindHeader, UUID_RE } from '@tagconn/shared';
import type { Deps } from '../../core/di/index.js';
import { redactPayload } from './redact.js';

export type IngestResult = { accepted: true } | { accepted: false; reason: string };

export interface IngestOptions {
  ts?: number;
  /**
   * Raw `x-tagconn-run-id` header value, if any. Validated here (UUID shape); anything else is
   * ignored (M8 8k, §2.6 "Hint" — a correlation hint only, never authority).
   */
  runIdHeader?: string;
  /** Raw `x-tagconn-project-root` header (base64); validated by `parseProjectRootHeader`, else ignored. */
  projectRootHeader?: string;
  /** Raw `x-tagconn-project-root-kind` header (`git` | `dir`); anything else is ignored. */
  projectRootKindHeader?: string;
}

export class IngestService {
  constructor(private readonly deps: Deps<'settings' | 'bus'>) {}

  /** Filters, redacts and publishes one hook payload on the bus (synchronously). */
  ingest(raw: HookPayload, opts: IngestOptions = {}): IngestResult {
    const { ingest } = this.deps.settings.get();
    if (!ingest.enabledEvents.includes(raw.hook_event_name)) return { accepted: false, reason: 'event disabled' };

    // Redact the whole payload (message, unknown passthrough keys, everything) before it is ever
    // stored or emitted; downstream bubbles/summaries all read from this same redacted object.
    const payload = redactPayload(raw as unknown as Record<string, unknown>, ingest.redactPatterns) as unknown as HookPayload;
    // `cwd` is as untrusted as the root header: an invalid one is treated as missing.
    const { cwd: rawCwd, ...rest } = payload;
    const cwd = parseProjectPath(rawCwd);
    const clean: HookPayload = cwd === undefined ? (rest as HookPayload) : { ...rest, cwd };
    const runIdHint = opts.runIdHeader && UUID_RE.test(opts.runIdHeader) ? opts.runIdHeader : undefined;

    const projectRoot = parseProjectRootHeader(opts.projectRootHeader);

    this.deps.bus.emit('hook.received', {
      payload: clean,
      ts: opts.ts ?? Date.now(),
      projectId: '',
      sessionId: clean.session_id,
      agentId: '',
      runIdHint,
      projectRoot,
      projectRootKind: projectRoot ? parseProjectRootKindHeader(opts.projectRootKindHeader) : undefined,
      storePayload: ingest.storeToolPayloads,
    });
    return { accepted: true };
  }
}
