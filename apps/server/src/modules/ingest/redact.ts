const REDACTED = '[redacted]';

/** Per-leaf-string cap before scanning: bounds regex work and stored/emitted size. */
const MAX_LEAF_CHARS = 64 * 1024;
const TRUNCATE_SUFFIX = '…[truncated]';

/** Structural ids that must reach storage/UI unredacted (they are never secrets). */
const STRUCTURAL_KEYS = new Set(['session_id', 'agent_id', 'tool_use_id', 'hook_event_name']);

type Replacer = (substring: string, ...groups: string[]) => string;
interface BuiltinPattern {
  re: RegExp;
  replace: Replacer;
}

const redactAll: Replacer = () => REDACTED;

/**
 * Built-in patterns applied ALWAYS, independent of (and in addition to) settings.ingest.redactPatterns.
 * Order matters: bearer/basic runs before the generic key/value pattern so `"Authorization":"Bearer x"`
 * loses its token before the generic pattern would otherwise swallow the whole key:value pair.
 */
function builtinPatterns(): BuiltinPattern[] {
  return [
    // key/value pairs (api_key, secret, token, password, authorization, ...). When the value itself
    // starts with a Bearer/Basic scheme, also consume the actual token that follows it, so
    // `"Authorization": "Bearer <jwt>"`-style values are fully redacted, not just the word "Bearer".
    {
      re: /(api[_-]?key|secret|token|password|passwd|authorization)["'\s:=]+(?:(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|[^\s"',]+)/gi,
      replace: redactAll,
    },
    { re: /(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, replace: redactAll },
    { re: /AKIA[0-9A-Z]{16}/g, replace: redactAll },
    { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[^-]*-----/g, replace: redactAll },
    // URL credentials: keep the scheme and user, drop the password. Quantifiers are bounded (real
    // schemes/usernames/passwords are short) so a long non-matching string can't cause catastrophic
    // backtracking (this pattern is quadratic-time on a huge run of scheme-like characters otherwise).
    {
      re: /([a-z][a-z0-9+.-]{0,15}:\/\/[^:\s/@]{1,255}:)[^@\s]{1,255}@/gi,
      replace: (_m, scheme: string) => `${scheme}${REDACTED}@`,
    },
    { re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, replace: redactAll },
    // mysql -p<password> (no space between -p and the value); keep the leading whitespace.
    { re: /\s-p\S+/g, replace: () => ` -p${REDACTED}` },
  ];
}

const userPatternCache = new WeakMap<readonly string[], RegExp[]>();

function compileUserPatterns(patterns: readonly string[]): RegExp[] {
  let compiled = userPatternCache.get(patterns);
  if (!compiled) {
    compiled = patterns.flatMap((p) => {
      try {
        return [new RegExp(p, 'gi')];
      } catch {
        return []; // invalid regexes are rejected by SettingsService; skip defensively
      }
    });
    userPatternCache.set(patterns, compiled);
  }
  return compiled;
}

function allPatterns(userPatterns: readonly string[]): BuiltinPattern[] {
  return [...builtinPatterns(), ...compileUserPatterns(userPatterns).map((re) => ({ re, replace: redactAll }))];
}

function applyPatterns(text: string, patterns: BuiltinPattern[]): string {
  let out = text;
  for (const { re, replace } of patterns) out = out.replace(re, replace as (...args: string[]) => string);
  return out;
}

/** Truncates every string leaf to MAX_LEAF_CHARS before it is scanned/serialized. */
function truncateLeaves(v: unknown): unknown {
  if (typeof v === 'string') return v.length > MAX_LEAF_CHARS ? v.slice(0, MAX_LEAF_CHARS) + TRUNCATE_SUFFIX : v;
  if (Array.isArray(v)) return v.map(truncateLeaves);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, truncateLeaves(x)]));
  return v;
}

/** Fallback when the JSON-text substitution breaks JSON syntax (e.g. a property literally named
 *  "password"): apply every pattern to each string leaf directly, preserving object structure. */
function redactLeaves(v: unknown, patterns: BuiltinPattern[]): unknown {
  if (typeof v === 'string') return applyPatterns(v, patterns);
  if (Array.isArray(v)) return v.map((x) => redactLeaves(x, patterns));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactLeaves(x, patterns)]));
  return v;
}

/**
 * Redacts a single value (kept for narrow, single-field use if ever needed): truncates long strings,
 * then applies the built-in + configured patterns.
 */
export function redactValue<T>(value: T, userPatterns: readonly string[]): T {
  if (value === undefined || value === null) return value;
  const patterns = allPatterns(userPatterns);
  const truncated = truncateLeaves(value);
  if (typeof truncated === 'string') return applyPatterns(truncated, patterns) as T;
  const json = JSON.stringify(truncated);
  const redacted = applyPatterns(json, patterns);
  if (redacted === json) return truncated as T;
  try {
    return JSON.parse(redacted) as T;
  } catch {
    return redactLeaves(truncated, patterns) as T;
  }
}

/**
 * Redacts the ENTIRE hook payload before anything is stored/emitted: every string leaf (including
 * `message` and unknown passthrough keys from `z.looseObject`), except the structural id fields,
 * which are never scanned so they always survive verbatim.
 */
export function redactPayload<T extends Record<string, unknown>>(raw: T, userPatterns: readonly string[]): T {
  const structural: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (STRUCTURAL_KEYS.has(key)) {
      if (value !== undefined) structural[key] = value;
    } else {
      rest[key] = value;
    }
  }
  const redactedRest = redactValue(rest, userPatterns);
  return { ...(redactedRest as Record<string, unknown>), ...structural } as T;
}
