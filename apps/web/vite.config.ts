import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Same security headers nginx sends in production (`docker/nginx.conf`; docs/design/runner-and-
 * helpdesk.md section 5.3), so a CSP violation shows up while developing instead of only after a
 * docker build (D1's acceptance: "the app works under CSP"). `preview` serves the built `dist/`
 * (no dev server, no HMR) and gets this verbatim; `server` (the dev server) layers on the narrow,
 * documented relaxations below that only Vite's own dev-time machinery needs.
 */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
  "font-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/**
 * Two dev-only relaxations, each found by actually loading `/?demo=1` under the strict CSP above and
 * reading the resulting console errors (not guessed):
 *   - `script-src 'unsafe-inline'`: `@vitejs/plugin-react` injects its Fast Refresh preamble as a
 *     literal inline `<script type="module">…</script>` on every page load (no nonce/hash option).
 *   - `style-src 'unsafe-inline'`: Vite's own CSS-HMR client (`@vite/client`'s `updateStyle`) replaces
 *     a changed stylesheet by setting `textContent` on a `<style>` element — a style *element*, not a
 *     CSSOM property write, so it's gated by `style-src` same as an inline `<style>` block. (Tailwind's
 *     Vite plugin itself injects nothing inline; this is Vite's HMR runtime, not Tailwind.)
 * Vite can avoid both via a nonce (`cspNonce` read from `<meta property="csp-nonce" nonce="...">`,
 * regenerated per request) instead of `'unsafe-inline'`, but that needs a custom index.html transform
 * to mint and inject a fresh nonce every request — not worth it for a dev-only, localhost policy.
 * Neither relaxation reaches the built SPA: `index.html` has no inline script, HMR doesn't run, and
 * nginx's CSP (mirrored in `CSP` above, used verbatim by `preview`) is unchanged.
 */
const DEV_CSP = CSP.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';").replace("style-src 'self';", "style-src 'self' 'unsafe-inline';");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_OFFICE_SERVER || 'http://localhost:4317';
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      headers: { ...SECURITY_HEADERS, 'Content-Security-Policy': DEV_CSP },
      proxy: {
        '/api': { target, changeOrigin: true },
        '/socket.io': { target, ws: true, changeOrigin: true },
      },
    },
    preview: { port: 4173, headers: SECURITY_HEADERS },
    build: {
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: { manualChunks: { phaser: ['phaser'] } },
      },
    },
  };
});
