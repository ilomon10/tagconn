// Moved to core/redact (M8 S2: shared by ingest and the runs module's run-event redaction). This
// re-export shim keeps every existing `from './redact.js'` import in this module working unchanged.
export * from '../../core/redact/index.js';
