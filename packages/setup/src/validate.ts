// Hook token: 16-128 lowercase hex chars (matches the 24-byte hex tokens the installer generates, but
// accepts any hex secret of reasonable length).
export const TOKEN_RE = /^[0-9a-f]{16,128}$/;
// Runner token (packages/shared/src/runner.ts RUNNER_TOKEN_RE): 32-128 lowercase hex chars. Wider than the
// hook token because it is also used as an HMAC key (docs/design/runner-and-helpdesk.md §2.2/§5.2).
export const RUNNER_TOKEN_RE = /^[0-9a-f]{32,128}$/;
// Role template `name` frontmatter: used to build a filesystem path, so keep it to a safe slug
// (lowercase, digits, dashes; 2-41 chars).
export const ROLE_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

/** Validates a hook token: 16-128 lowercase hex chars (see TOKEN_RE). */
export function isValidToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

/** Validates a runner token: 32-128 lowercase hex chars (see RUNNER_TOKEN_RE). */
export function isValidRunnerToken(token: string): boolean {
  return RUNNER_TOKEN_RE.test(token);
}

/** Validates a role template's `name` frontmatter (see ROLE_NAME_RE). */
export function isValidRoleName(name: string): boolean {
  return ROLE_NAME_RE.test(name);
}

/**
 * Rejects a path containing a single quote: the config dir is embedded, single-quoted, in the sh hook
 * command written to settings.json (see `hookEntryFor`), so a stray `'` would break out of the quoting.
 */
export function validateNoSingleQuote(path: string, label: string): void {
  if (path.includes("'")) {
    throw new Error(`${label} must not contain a single quote (got ${JSON.stringify(path)})`);
  }
}

/** Validates a server URL: http(s) only, no whitespace/quotes, parseable by `new URL()`. */
export function validateUrl(raw: string): string {
  if (/["'\s]/.test(raw)) {
    throw new Error(`--url is invalid: must not contain whitespace or quotes (got ${JSON.stringify(raw)})`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`--url is invalid: ${JSON.stringify(raw)} is not a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`--url must use http or https (got ${JSON.stringify(parsed.protocol)})`);
  }
  return raw.replace(/\/+$/, '');
}
