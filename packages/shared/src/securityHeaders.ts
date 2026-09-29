/**
 * ONE source for the web security headers. The server's static web plugin (core/web) and the Vite dev/
 * preview servers import this; `docker/nginx.conf` stays hand-written but a server test parses it and
 * asserts it sends exactly these values, so the copies can never drift.
 */

export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
  "font-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

/** Vite dev only: the plugin-react Fast Refresh inline script and Vite's CSS HMR `<style>` updates need these. Never used for a built app. */
export const DEV_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';").replace(
  "style-src 'self';",
  "style-src 'self' 'unsafe-inline';",
);

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export const ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const INDEX_CACHE_CONTROL = 'no-store';
