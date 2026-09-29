// Log lines leave the supervisor already redacted (LogLine.line contract). Known tokens are masked
// exactly; the patterns catch the rest (mirrors the ingest defaults in packages/shared settings.ts).

const PATTERNS: [RegExp, string][] = [
  [/(api[_-]?key|secret|token|password|passwd|authorization)(["'\s:=]+)(?:(?:Bearer|Basic)\s+)?[^\s"',]+/gi, '$1$2[redacted]'],
  [/sk-[A-Za-z0-9_-]{20,}/g, '[redacted]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  // Hook and runner tokens are 16-128 lowercase hex chars; HMAC proofs and nonces are long opaque strings.
  [/\b[0-9a-f]{32,}\b/g, '[redacted]'],
  [/(#pair=)[^\s&"']+/g, '$1[redacted]'],
];

const MIN_SECRET_LENGTH = 8;

export function redact(line: string, secrets: Iterable<string> = []): string {
  let out = line;
  for (const s of secrets) {
    if (s.length >= MIN_SECRET_LENGTH) out = out.split(s).join('[redacted]');
  }
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}
