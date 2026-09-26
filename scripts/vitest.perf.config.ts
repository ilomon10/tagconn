import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Timing/perf-budget tests only (see vitest.config.ts, which excludes these from the
// default `pnpm run test:scripts` run): they measure real wall-clock duration against a
// budget and flake when the machine is loaded, so they run on their own via `pnpm test:perf`.
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    include: ['__tests__/**/*.perf.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Same backstop as vitest.config.ts: these tests spawn the real hook script too.
    fileParallelism: false,
    globalSetup: ['./__tests__/support/global-guard.ts'],
  },
});
